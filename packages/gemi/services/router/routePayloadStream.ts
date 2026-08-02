import type { ServerQueryStore } from "./ServerQueryStore";

/**
 * How long a navigation payload may keep streaming query results before it
 * closes with whatever has settled. A hung query must not hold the response
 * open — the suspended segment it strands resolves over `/api` instead.
 */
const PAYLOAD_STREAM_DEADLINE_MS = 10_000;

/**
 * The streamed `.json` navigation response (#290): NDJSON, one JSON value per
 * line.
 *
 * - **Line 1 — the envelope**: route data, meta, i18n, partial info, and the
 *   `prefetchedData` that has already resolved. Written immediately, so the
 *   client can commit the navigation at handler speed instead of waiting for
 *   `allSettled` — the blocking that made priming a heavy query a tax on
 *   every navigation.
 * - **Later lines — query payloads**: `[path, variantKey, data]`, one per
 *   query as it settles. The client hydrates each into the cache, which
 *   settles any segment suspended on that variant — the same wake path the
 *   document stream uses.
 *
 * The envelope is an object and payload lines are arrays, which is how the
 * reader tells them apart. `JSON.stringify` never emits a raw newline, so
 * line framing is unambiguous. Rejected queries stream nothing: the
 * suspended segment's own `/api` fetch surfaces the error into its boundary.
 */
export function createRoutePayloadStream(
  envelope: unknown,
  store: ServerQueryStore,
  deadlineMs: number = PAYLOAD_STREAM_DEADLINE_MS,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline);
        try {
          controller.close();
        } catch {}
      };

      controller.enqueue(encoder.encode(`${JSON.stringify(envelope)}\n`));

      // Entries the envelope's snapshot already shipped are skipped by the
      // store itself (same contract the document injector relies on).
      store.onSettle((entry) => {
        if (closed || entry.status !== "resolved") return;
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify([entry.path, entry.variantKey, entry.data])}\n`,
          ),
        );
      });

      const deadline = setTimeout(close, deadlineMs);
      store.allSettled().then(close, close);
    },
  });
}
