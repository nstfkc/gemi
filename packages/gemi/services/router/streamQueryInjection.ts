import type { DictionarySink, DictionaryUse } from "../../i18n/dictionarySink";
import type { ServerQueryEntry, ServerQueryStore } from "./ServerQueryStore";

/**
 * `</script>`-safe (and `<!--`-safe) JSON for inlining into an HTML script
 * element: any `<` in the data would otherwise let a string value close the
 * tag and inject markup.
 */
export function htmlSafeJson(value: unknown): string {
  return JSON.stringify(value)
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
  const forward = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: Uint8Array,
  ) => {
    controller.enqueue(chunk);
    hooks.onChunk?.(chunk);
  };
  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (queue.length > 0) {
      forward(controller, encoder.encode(queue.shift()!));
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
        forward(controller, value);
        hooks.onShell?.();
        flush(controller);
        return;
      }
      flush(controller);
      forward(controller, value);
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
