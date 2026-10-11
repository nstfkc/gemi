import { useEffect, useRef, useState } from "react";

import type { ChangeFeedEvent } from "../services/change-feed/ChangeFeedDriver";
import type { ChangeFeedResponse } from "../services/change-feed/wire";
import { applyParams } from "../utils/applyParams";
import { loadedModule } from "./realtime/loader";
import type { SubscriptionState } from "./subscriptionStream";
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

/** `./subscriptionStream`, loaded on first use. Replaceable in tests. */
export const streamModule = {
  load: () => import("./subscriptionStream.js"),
};

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
  const [state, setState] = useState<SubscriptionState>({
    status: enabled ? "connecting" : "closed",
    cursor: cursor.current,
    error: null,
  });

  useEffect(() => {
    cursor.current = config.cursor ?? null;
  }, [endpoint, config.cursor]);

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, status: "closed" }));
      return;
    }
    // The connection is loaded on first use; see `./subscriptionStream`.
    let stopped = false;
    let stop: (() => void) | null = null;
    streamModule
      .load()
      .then((module) => {
        const { follow } = loadedModule(module);
        if (stopped) return;
        stop = follow({
          endpoint,
          pauseWhenHidden,
          cursor,
          callbacks: callbacks as { current: SubscriptionConfig<unknown> },
          setState,
        });
      })
      .catch((error: unknown) => {
        // A chunk that will not load (usually a deploy; `init`'s chunk-load
        // recovery reloads the page for it) or a module that failed to
        // evaluate: no connection to retry.
        if (!stopped) setState((s) => ({ ...s, status: "closed", error: error as Error }));
      });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [endpoint, enabled, pauseWhenHidden, config.cursor]);

  return state;
}
