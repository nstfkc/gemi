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
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue: string[] = [];
  let sentFirstChunk = false;

  store.onSettle((entry) => {
    // Rejected entries stream nothing: React client-renders that segment and
    // the browser's own `/api` fetch surfaces the error into the boundary.
    if (entry.status !== "resolved") return;
    queue.push(queryPayloadScript(entry));
  });

  const reader = source.getReader();
  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (queue.length > 0) {
      controller.enqueue(encoder.encode(queue.shift()!));
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // Queries nothing rendered (an unused prefetch) settle after React's
        // last chunk — they still belong in the client cache.
        flush(controller);
        controller.close();
        return;
      }
      if (!sentFirstChunk) {
        sentFirstChunk = true;
        controller.enqueue(value);
        flush(controller);
        return;
      }
      flush(controller);
      controller.enqueue(value);
    },
    cancel(reason) {
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
