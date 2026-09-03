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

/**
 * How long a connection may sit idle before a comment line goes out.
 *
 * The nearest ceiling is not a proxy but our own server: Bun's `idleTimeout`
 * counts socket silence, a streaming body included, and gemi runs at its
 * 10-second default unless `SERVER_IDLE_TIMEOUT` says otherwise. A comment
 * line every 25 seconds was measured to lose the connection at 12; every 5
 * keeps it open, with room for a write that lands late. Azure App Service's
 * front end, at about 230 seconds, is the far ceiling, and 5 clears it by the
 * same margin. A thousand quiet streams cost two hundred thirteen-byte writes
 * a second, which is nothing. Both encoders read this one value, so the two
 * cannot drift apart.
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 5_000;

/**
 * The comment line itself. A line starting with `:` is a comment under the SSE
 * spec: every parser on our side skips it, and so does the browser's own
 * `EventSource`.
 */
export const SSE_KEEPALIVE = ": keepalive\n\n";

/**
 * Writes a keepalive whenever the stream has been silent for the interval.
 *
 * Armed on creation because the silence before the first frame is real
 * silence too — a model thinking is the common case. `touch()` after every
 * frame is what makes it measure silence rather than elapsed time; `stop()`
 * on close or cancel is what keeps a finished stream from holding a timer.
 *
 * The write is guarded because a cancel can land between the timer firing and
 * the enqueue, and a closed controller throws. There is nothing to do about
 * that except stop. `arm` checks `stopped` too, so a `touch()` that arrives
 * after `stop()` cannot hand a finished stream a timer for one more interval.
 */
export function sseKeepalive(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalMs = SSE_KEEPALIVE_INTERVAL_MS,
): { touch(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      try {
        controller.enqueue(encoder.encode(SSE_KEEPALIVE));
      } catch {
        stop();
        return;
      }
      arm();
    }, intervalMs);
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  arm();
  return { touch: arm, stop };
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
  let keepalive!: ReturnType<typeof sseKeepalive>;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      keepalive = sseKeepalive(controller);
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          keepalive.stop();
          controller.close();
          return;
        }
        lastSeq = next.value.seq;
        controller.enqueue(encoder.encode(encodeFrame(next.value)));
        keepalive.touch();
      } catch (err) {
        // Past the headers there is no status left to fail with, so the reason
        // goes out as the last event. Closing silently would be
        // indistinguishable from a run that finished, which is the one thing a
        // reattaching client must not be told by mistake.
        const event = { type: "error", error: toAgentError(err) } as const;
        keepalive.stop();
        controller.enqueue(encoder.encode(encodeFrame({ seq: lastSeq + 1, event })));
        controller.close();
      }
    },
    cancel(reason) {
      // The client went away. Let the generator unwind so its `finally` runs
      // and it stops waiting on frames nobody will read.
      keepalive.stop();
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
