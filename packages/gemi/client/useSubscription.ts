import { useEffect, useRef, useState } from "react";

import type { ChangeFeedEvent } from "../services/change-feed/ChangeFeedDriver";
import type { ChangeFeedMessage, ChangeFeedResponse } from "../services/change-feed/wire";
import { applyParams } from "../utils/applyParams";
import type { UrlParser } from "./types";
import type { Data, GetRPC } from "./useQuery";
import { useParams } from "./useParams";

/** The `data` a route's `ChangeFeed.stream<T>()` publishes, or `unknown`. */
export type SubscriptionData<T extends keyof GetRPC> =
  Data<T> extends ChangeFeedResponse<infer D> ? D : unknown;

export type SubscriptionStatus = "connecting" | "open" | "paused" | "closed";

export type SubscriptionOptions<T extends keyof GetRPC> = {
  params?: Partial<UrlParser<`${T & string}`>>;
  search?: Record<string, string | number | boolean | null>;
};

export type SubscriptionConfig<D> = {
  /** Each change, in order. */
  onChange?: (event: Extract<ChangeFeedEvent<D>, { type: "change" }>) => void;
  /**
   * The subscription could not be brought up to date change by change (it
   * was away longer than the server keeps changes): read the resource again.
   */
  onReset?: (event: Extract<ChangeFeedEvent<D>, { type: "reset" }>) => void;
  /**
   * Where to start, from `ChangeFeed.cursor()` in the view's data, so that a
   * change made between the server rendering the view and the browser
   * connecting is not missed. Default: the channels' heads when connecting.
   */
  cursor?: string | null;
  /** `false` disconnects. Default `true`. */
  enabled?: boolean;
  /**
   * Disconnect while the tab is hidden, and catch up from the cursor once it
   * is shown again. Default `true`.
   */
  pauseWhenHidden?: boolean;
};

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** The server answered in a way retrying will not change (401, 403, 404). */
class FatalStatus extends Error {
  constructor(readonly status: number) {
    super(`The subscription was refused with ${status}.`);
  }
}

/**
 * Follows a route that answers with `ChangeFeed.stream`, as long as the
 * component is mounted: each change reaches `onChange`, in order, exactly
 * once, across dropped connections and hidden tabs.
 *
 * ```tsx
 * const { status } = useSubscription(
 *   "/sites/:siteId/changes",
 *   { params: { siteId } },
 *   { cursor: site.cursor, onChange: ({ data }) => apply(data), onReset: () => reload() },
 * );
 * ```
 *
 * It reconnects after a drop with backoff (1 s doubling to 30 s, or the
 * server's `Retry-After`), resuming with `Last-Event-ID` from the last event
 * it saw. A `4xx` other than `408` and `429` stops it, with status `closed`.
 * The callbacks may change between renders without reconnecting.
 */
export function useSubscription<T extends keyof GetRPC>(
  url: T,
  options: SubscriptionOptions<T> = {},
  config: SubscriptionConfig<SubscriptionData<T>> = {},
): { status: SubscriptionStatus; cursor: string | null; error: Error | null } {
  const routeParams = useParams();
  const params = { ...routeParams, ...(options.params as Record<string, string>) };
  const search = new URLSearchParams(
    Object.entries(options.search ?? {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  search.sort();
  const path = [applyParams(String(url), params), search.toString()].filter(Boolean).join("?");
  const endpoint = `/api${path}`;
  const enabled = config.enabled !== false;
  const pauseWhenHidden = config.pauseWhenHidden !== false;

  const callbacks = useRef(config);
  useEffect(() => {
    callbacks.current = config;
  });
  // The cursor survives a change of callbacks, a pause and a reconnect, and
  // starts over only for another endpoint or another starting cursor.
  const cursor = useRef<string | null>(config.cursor ?? null);
  const [state, setState] = useState<{
    status: SubscriptionStatus;
    cursor: string | null;
    error: Error | null;
  }>({ status: enabled ? "connecting" : "closed", cursor: cursor.current, error: null });

  useEffect(() => {
    cursor.current = config.cursor ?? null;
  }, [endpoint, config.cursor]);

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, status: "closed" }));
      return;
    }
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
  }, [endpoint, enabled, pauseWhenHidden, config.cursor]);

  return state;
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
