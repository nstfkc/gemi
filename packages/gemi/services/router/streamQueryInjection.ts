import type { DictionarySink, DictionaryUse } from "../../i18n/dictionarySink";
import { createHtmlInsertionScanner } from "./htmlInsertionPoint";
import type { ServerQueryEntry, ServerQueryStore } from "./ServerQueryStore";

/**
 * `</script>`-safe (and `<!--`-safe) JSON for inlining into an HTML script
 * element: any `<` in the data would otherwise let a string value close the
 * tag and inject markup.
 */
export function htmlSafeJson(value: unknown): string {
  const json = JSON.stringify(value);
  // `JSON.stringify(undefined)` is `undefined`, not `"undefined"`, so the
  // `.replace` below would throw on it. That is unreachable for a query payload
  // but not for the document bootstrap, which serializes `err.stack` \u2014 absent on
  // anything thrown that is not an `Error`. Throwing there would replace the
  // error page with a second, worse error raised inside the error handler.
  if (json === undefined) {
    return "undefined";
  }
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function queryPayloadScript(entry: ServerQueryEntry): string {
  const payload = htmlSafeJson([entry.path, entry.variantKey, entry.data]);
  // Self-shimming: the first payload to arrive creates the buffer, so no
  // separate bootstrap is needed and execution order never matters.
  return `<script>(self.__GEMI_STREAM__=self.__GEMI_STREAM__||[]).push(${payload})</script>`;
}

/**
 * The same trick for a `defineDictionary` dictionary a segment just rendered
 * with. It rides the same queue as query payloads, so it lands ahead of the
 * reveal chunk for the segment that used it and hydration never re-fetches
 * strings the document already carries.
 */
export function dictionaryPayloadScript(use: DictionaryUse): string {
  const payload = htmlSafeJson([use.id, use.locale, use.strings]);
  return `<script>(self.__GEMI_DICT__=self.__GEMI_DICT__||[]).push(${payload})</script>`;
}

/**
 * The injector sits at the end of the response pipe, so it is the one place
 * that knows when the body's first byte goes out and when the body actually
 * closes — the two marks a handler-scoped span gets wrong under streaming.
 */
export interface StreamLifecycleHooks {
  /** The response's first chunk was enqueued — time-to-shell. */
  onShell?: () => void;
  /**
   * Every chunk enqueued into the response body, in order — the byte stream
   * exactly as the client receives it, injected payload scripts included.
   * The dev-mode shell-content measurement (#294) hangs here.
   */
  onChunk?: (chunk: Uint8Array) => void;
  /**
   * The body closed: the last chunk (and any leftover payload scripts)
   * flushed, the client went away, or the source stream errored. Fires
   * exactly once.
   */
  onClose?: () => void;
}

/**
 * Interleaves resolved query payloads with React's streamed HTML.
 *
 * A manual pull-pump around the source, not a `pipeThrough` — React's SSR
 * stream is a byte stream, and piping one through a `TransformStream` stalls
 * chunk delivery until close under Node's web-streams implementation. Pulling
 * with a plain reader behaves identically under Bun and Node.
 *
 * Ordering is the whole point, and it is guaranteed by construction twice
 * over:
 *
 * 1. Payload before reveal. The store queues the payload script *before* it
 *    settles the promise the suspended segment threw (see
 *    `ServerQueryStore.ensure`), and React only starts re-rendering the
 *    segment after that promise resolves. By the time React produces the
 *    segment's reveal chunk, the script is already waiting in `queue` — and
 *    every forwarded chunk is preceded by a queue flush, so the script lands
 *    first. Hydration can therefore never see a revealed segment whose data
 *    isn't in the client cache.
 *
 * 2. Nothing before the shell's first byte. The queue is never flushed ahead
 *    of the first React chunk, so a query that settles before streaming
 *    begins can't push a script in front of `<!doctype html>`. (Those are
 *    normally in the `__GEMI_DATA__` snapshot anyway and skipped here.)
 *
 * 3. Only ever between elements. React's chunk boundaries fall at arbitrary
 *    byte offsets — 2048-byte views, not markup — so "flush at a chunk
 *    boundary" used to splice scripts into the middle of a tag or into a
 *    `<style>` body (#404). The scanner tracks the emitted bytes' parse state
 *    and the flush moves to the first DATA-state offset *inside* the chunk
 *    instead, which is still ahead of anything else that chunk carries. That
 *    keeps guarantee 1: the reveal script cannot precede the payload, because
 *    the earliest safe offset is at worst the end of the one tag straddling
 *    the boundary.
 */
export function injectQueryPayloads(
  source: ReadableStream<Uint8Array>,
  store: ServerQueryStore,
  hooks: StreamLifecycleHooks = {},
  dictionaries?: DictionarySink,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue: string[] = [];
  let sentFirstChunk = false;
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    hooks.onClose?.();
  };

  store.onSettle((entry) => {
    // Rejected entries stream nothing: React client-renders that segment and
    // the browser's own `/api` fetch surfaces the error into the boundary.
    if (entry.status !== "resolved") return;
    queue.push(queryPayloadScript(entry));
  });

  // Dictionaries read during render join the same queue, and inherit its
  // ordering guarantee: `useDictionary` reports a dictionary while rendering
  // the segment that uses it, so the script is queued before React can emit
  // that segment's chunk.
  dictionaries?.onUse((use) => {
    queue.push(dictionaryPayloadScript(use));
  });

  const reader = source.getReader();
  const scanner = createHtmlInsertionScanner();
  const forward = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: Uint8Array,
  ) => {
    controller.enqueue(chunk);
    hooks.onChunk?.(chunk);
  };
  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (queue.length > 0) {
      const script = encoder.encode(queue.shift()!);
      // Scanned like any other output so the state stays continuous. A payload
      // script is balanced markup, so this always lands back in DATA.
      scanner.write(script);
      forward(controller, script);
    }
  };

  /**
   * Forward one React chunk, splicing the queue in at the first offset the
   * parser would read a `<script>` as markup — offset 0 when the previous
   * chunk ended between elements, which is the common case.
   */
  const forwardWithPayloads = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: Uint8Array,
  ) => {
    if (queue.length === 0) {
      scanner.write(chunk);
      forward(controller, chunk);
      return;
    }
    const at = scanner.scanToInsertionPoint(chunk);
    if (at > 0) {
      forward(controller, chunk.subarray(0, at));
    }
    // False only when the whole chunk was consumed without ever reaching DATA
    // (one very long tag or raw-text element), in which case the payload waits
    // for the next chunk — or, failing that, for the stream-end flush.
    if (scanner.isSafe()) {
      flush(controller);
    }
    const rest = chunk.subarray(at);
    if (rest.length > 0) {
      scanner.write(rest);
      forward(controller, rest);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (err) {
        // A source error (React's stream failing post-shell) still ends the
        // body — without this, "fires exactly once" would be zero times on
        // the error exit, leaking whatever span `onClose` was meant to end.
        closeOnce();
        throw err;
      }
      const { done, value } = result;
      if (done) {
        // Queries nothing rendered (an unused prefetch) settle after React's
        // last chunk — they still belong in the client cache.
        flush(controller);
        controller.close();
        closeOnce();
        return;
      }
      if (!sentFirstChunk) {
        sentFirstChunk = true;
        scanner.write(value);
        forward(controller, value);
        hooks.onShell?.();
        // Guarantee 2 forbids splicing *into* the first chunk, so the queue
        // goes out behind it — and only if that chunk ended cleanly. A settled
        // (`no-stream`) document arrives with its whole backlog already queued,
        // which is why this boundary was the one that broke deterministically.
        if (scanner.isSafe()) {
          flush(controller);
        }
        return;
      }
      forwardWithPayloads(controller, value);
    },
    cancel(reason) {
      closeOnce();
      return reader.cancel(reason);
    },
  });
}

/**
 * Crawlers don't run scripts and don't wait — they index whatever HTML the
 * response body contains, so they get the fully-settled document
 * (`stream.allReady`) instead of a shell with fallbacks.
 */
const BOT_UA =
  /bot|crawler|spider|crawling|slurp|bingpreview|mediapartners|headless|lighthouse|prerender|facebookexternalhit|whatsapp|telegram|discord|twitterbot|linkedinbot/i;

export function isBotUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return BOT_UA.test(userAgent);
}
