import { SSE_KEEPALIVE, sseHeaders } from "../../ai/store/sse";
import { isShuttingDown } from "../../server/shutdown";
import type { ChangeFeedMessage, ChangeFeedResponse } from "./wire";
import { ChangeFeedFullError, type ChangeFeedManager, type ChangeFeedSubscription } from "./ChangeFeedManager";

export type StreamOptions = {
  /**
   * Where to resume. Default: the request's `Last-Event-ID` header, then its
   * `cursor` search parameter, then the channels' heads.
   */
  cursor?: string | null;
  /** How long a client waits before retrying a `503`, in seconds. Default `5`. */
  retryAfter?: number;
};

const encoder = new TextEncoder();

function frame(id: string, message: ChangeFeedMessage): Uint8Array {
  return encoder.encode(`id: ${id}\ndata: ${JSON.stringify(message)}\n\n`);
}

export type { ChangeFeedMessage, ChangeFeedResponse };

export function changeFeedStream<T>(
  manager: ChangeFeedManager,
  request: { rawRequest: Request } | Request,
  channels: string[],
  options: StreamOptions,
): ChangeFeedResponse<T> {
  const raw = request instanceof Request ? request : request.rawRequest;
  const cursor =
    options.cursor ??
    raw.headers.get("Last-Event-ID") ??
    new URL(raw.url).searchParams.get("cursor");

  let subscription: ChangeFeedSubscription;
  try {
    subscription = manager.subscribe(channels, { cursor, signal: raw.signal });
  } catch (error) {
    if (!(error instanceof ChangeFeedFullError)) throw error;
    return new Response(JSON.stringify({ error: "The change feed is at capacity." }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(options.retryAfter ?? 5),
      },
    });
  }

  let keepalive: ReturnType<typeof setInterval> | null = null;
  let sentReady = false;
  let closed = false;
  const end = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    subscription.close();
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Cancelled by the client already.
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      keepalive = setInterval(() => {
        // A stream never ends by itself, so a server draining its requests
        // ends it: the client reconnects, to an instance that is staying.
        if (isShuttingDown()) return end(controller);
        try {
          controller.enqueue(encoder.encode(SSE_KEEPALIVE));
        } catch {
          end(controller);
        }
      }, manager.config.keepaliveInterval);
    },
    async pull(controller) {
      try {
        if (!sentReady) {
          await subscription.ready();
          sentReady = true;
          if (!closed) controller.enqueue(frame(subscription.cursor, { type: "ready" }));
          return;
        }
        const next = await subscription.next();
        if (next.done || closed) return end(controller);
        controller.enqueue(frame(subscription.cursor, next.value));
      } catch (error) {
        // Past the headers there is no status to fail with. Closing lets the
        // client reconnect from the last id it saw, which is still right.
        if (!closed) console.error("[gemi] A change feed stream failed.", error);
        end(controller);
      }
    },
    cancel() {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      subscription.close();
    },
  });

  return new Response(body, { headers: sseHeaders() }) as ChangeFeedResponse<T>;
}
