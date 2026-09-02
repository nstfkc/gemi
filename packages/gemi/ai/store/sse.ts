import type { AgentError, AgentStreamFrame } from "../types";

const encoder = new TextEncoder();

/**
 * One frame, one SSE event.
 *
 * `id:` carries the frame's `seq`, which is what makes the browser's own
 * `Last-Event-ID` the right cursor on reconnect — the transport asks the
 * question the run already knows how to answer, and the client never has to
 * track a position of its own.
 */
export function encodeFrame(frame: AgentStreamFrame): string {
  return `id: ${frame.seq}\ndata: ${JSON.stringify(frame.event)}\n\n`;
}

export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    // `no-transform` as well as `no-store`: a proxy that gzips or rechunks the
    // body is a proxy that buffers it, and a buffered token stream arrives all
    // at once, which is the same as not streaming at all.
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    // nginx's own name for the same thing.
    "X-Accel-Buffering": "no",
  };
}

/**
 * Encodes an async iterable of frames as an SSE response.
 *
 * Pulls one frame per `pull` rather than looping inside `start`: a `start` that
 * awaits the whole run does not resolve until the run is over, and the stream
 * is not readable until it does — which would turn every streamed answer into a
 * single delivery at the end.
 */
export function sseResponse(frames: AsyncIterable<AgentStreamFrame>, status = 200): Response {
  const iterator = frames[Symbol.asyncIterator]();
  let lastSeq = -1;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        lastSeq = next.value.seq;
        controller.enqueue(encoder.encode(encodeFrame(next.value)));
      } catch (err) {
        // Past the headers there is no status left to fail with, so the reason
        // goes out as the last event. Closing silently would be
        // indistinguishable from a run that finished, which is the one thing a
        // reattaching client must not be told by mistake.
        const event = { type: "error", error: toAgentError(err) } as const;
        controller.enqueue(encoder.encode(encodeFrame({ seq: lastSeq + 1, event })));
        controller.close();
      }
    },
    cancel(reason) {
      // The client went away. Let the generator unwind so its `finally` runs
      // and it stops waiting on frames nobody will read.
      void iterator.return?.(reason);
    },
  });

  return new Response(body, { status, headers: sseHeaders() });
}

// `unknown` rather than a new code: `AgentErrorCode` is the wire contract and
// belongs to the model's failures, not to the transport's. The message names
// the cursor, which is what a client can actually act on.
function toAgentError(err: unknown): AgentError {
  return {
    code: "unknown",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}
