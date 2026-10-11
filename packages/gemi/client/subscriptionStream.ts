import type { Dispatch, SetStateAction } from "react";

import type { ChangeFeedMessage } from "../services/change-feed/wire";
import type { SubscriptionConfig, SubscriptionStatus } from "./useSubscription";

// `useSubscription`'s connection: the SSE request, its reader and the
// reconnect loop. Loaded by the hook with a dynamic `import()` when it first
// connects, so it lands in a chunk of its own rather than in the entry chunk
// every route loads (#891). Import it as a type only from anywhere else.

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** The server answered in a way retrying will not change (401, 403, 404). */
class FatalStatus extends Error {
  constructor(readonly status: number) {
    super(`The subscription was refused with ${status}.`);
  }
}

export interface SubscriptionState {
  status: SubscriptionStatus;
  cursor: string | null;
  error: Error | null;
}

export interface FollowOptions {
  endpoint: string;
  pauseWhenHidden: boolean;
  /** Where to resume; advanced as events arrive. */
  cursor: { current: string | null };
  callbacks: { current: SubscriptionConfig<unknown> };
  setState: Dispatch<SetStateAction<SubscriptionState>>;
}

/**
 * Follows `endpoint` until the returned function is called: connects,
 * reconnects with backoff, pauses while the tab is hidden, and reports
 * through `setState` and `callbacks`.
 */
export function follow({
  endpoint,
  pauseWhenHidden,
  cursor,
  callbacks,
  setState,
}: FollowOptions): () => void {
  let stopped = false;
  let request: AbortController | null = null;
  let resume: (() => void) | null = null;
  let retryMs = MIN_RETRY_MS;
  const hidden = () =>
    pauseWhenHidden && typeof document !== "undefined" && document.visibilityState === "hidden";
  const onVisibilityChange = () => {
    if (hidden()) request?.abort();
    else resume?.();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resume = null;
        resolve();
      }
      // Shown again, or unmounted: stop waiting.
      resume = done;
    });

  void (async () => {
    while (!stopped) {
      if (hidden()) {
        setState((s) => ({ ...s, status: "paused" }));
        await new Promise<void>((resolve) => (resume = resolve));
        resume = null;
        continue;
      }
      setState((s) => ({ ...s, status: "connecting" }));
      const controller = (request = new AbortController());
      let delay = retryMs;
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (cursor.current) headers["Last-Event-ID"] = cursor.current;
        const response = await fetch(endpoint, { headers, signal: controller.signal });
        if (!response.ok || !response.body) {
          const status = response.status;
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            throw new FatalStatus(status);
          }
          const retryAfter = Number(response.headers.get("Retry-After"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) delay = retryAfter * 1000;
          throw new Error(`The subscription answered ${status}.`);
        }
        for await (const { id, message } of readEvents(response.body)) {
          if (stopped) return;
          if (id !== undefined) cursor.current = id;
          if (message.type === "ready") {
            retryMs = MIN_RETRY_MS;
            delay = MIN_RETRY_MS;
            setState({ status: "open", cursor: cursor.current, error: null });
          } else {
            setState((s) => ({ ...s, cursor: cursor.current }));
            if (message.type === "change") callbacks.current.onChange?.(message as never);
            else if (message.type === "reset") callbacks.current.onReset?.(message as never);
          }
        }
      } catch (error) {
        if (stopped) return;
        if (error instanceof FatalStatus) {
          setState((s) => ({ ...s, status: "closed", error }));
          return;
        }
        // Aborted because the tab was hidden: the loop pauses instead.
        if (controller.signal.aborted) continue;
        setState((s) => ({ ...s, error: error as Error }));
      }
      if (stopped || controller.signal.aborted) continue;
      // The stream ended or failed: try again, a little later each time.
      setState((s) => ({ ...s, status: "connecting" }));
      await wait(delay);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  })();

  return () => {
    stopped = true;
    request?.abort();
    resume?.();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/**
 * The events of an SSE body: `id` and the JSON `data`. Comments (keepalives)
 * and events without data are skipped; an event whose data is not JSON is
 * dropped rather than ending the stream.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id?: string; message: ChangeFeedMessage }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      // `ChangeFeed.stream` writes `\n` only; a proxy's `\r\n` is folded here.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        let id: string | undefined;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line === "" || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let text = colon === -1 ? "" : line.slice(colon + 1);
          if (text.startsWith(" ")) text = text.slice(1);
          if (field === "id") id = text;
          else if (field === "data") data.push(text);
        }
        if (data.length === 0) continue;
        try {
          yield { id, message: JSON.parse(data.join("\n")) };
        } catch {
          // Not JSON: not ours to apply.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
