import { useContext, useEffect, useRef } from "react";

import { applyParams } from "../utils/applyParams";
import { toVariantKey } from "../utils/variantKey";
import { QueryManagerContext } from "./QueryManagerContext";
import type { ChannelParamValues } from "./realtime/RealtimeClient";
import { useChannelSubscription, type ChannelState } from "./realtime/useChannelSubscription";
import type { BroadcastRPC } from "./rpc";
import type { GetRPC } from "./useQuery";
import { useParams } from "./useParams";

/** A channel pattern the app's `ChannelRouter` declares (any string without one). */
export type ChannelPattern<R = BroadcastRPC> = [keyof R] extends [never]
  ? string
  : keyof R & string;

/** The params a pattern takes, from `BroadcastRPC`. */
export type ChannelParamsFor<P extends string, R = BroadcastRPC> = P extends keyof R
  ? R[P] extends { params: infer X }
    ? X
    : ChannelParamValues
  : ChannelParamValues;

/** The events a pattern's channel carries, from `BroadcastRPC`. */
export type ChannelEventsFor<P extends string, R = BroadcastRPC> = P extends keyof R
  ? R[P] extends { events: infer E extends Record<string, unknown> }
    ? E
    : Record<string, unknown>
  : Record<string, unknown>;

export interface UseChannelOptions<P extends string> {
  params?: ChannelParamsFor<P>;
}

export interface UseChannelConfig<Events extends Record<string, unknown>> {
  /** A handler per event name, called with the event's payload. */
  on?: { [E in keyof Events]?: (data: Events[E]) => void };
  /**
   * Events may have been missed — after a (re)connect, once the subscription
   * is acknowledged, or on a server `gap`: refetch what this channel
   * describes. Coalesced to one call per 2 s.
   */
  onResync?: () => void;
  /** `false` unsubscribes. Default `true`. */
  enabled?: boolean;
}

export type { ChannelState };
export type { ChannelStatus } from "./realtime/RealtimeClient";

const warnedWithoutResync = new Set<string>();

/**
 * Subscribes to a broadcast channel while the component is mounted.
 *
 * ```tsx
 * const { status } = useChannel("site.:siteId", { params: { siteId } }, {
 *   on: { changed: (d) => mutate({ path: "/pages/:pageId", params: { pageId } }) },
 *   onResync: () => mutate({ path: "/pages/:pageId", params: { pageId } }),
 * });
 * ```
 *
 * Events are hints, delivered at most once: pair `on` with `onResync`, which
 * runs whenever some may have been missed. `useChannelInvalidate` does both
 * for the common case. On the server, and until the effect runs, `status` is
 * `closed`.
 */
export function useChannel<P extends ChannelPattern>(
  pattern: P,
  options: UseChannelOptions<P> = {},
  config: UseChannelConfig<ChannelEventsFor<P>> = {},
): ChannelState {
  const configRef = useRef(config);
  configRef.current = config;
  const hasOn = config.on !== undefined && Object.keys(config.on).length > 0;
  const hasResync = config.onResync !== undefined;

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!hasOn || hasResync || warnedWithoutResync.has(pattern)) return;
    warnedWithoutResync.add(pattern);
    console.warn(
      `[gemi] useChannel("${pattern}") has \`on\` handlers but no \`onResync\`. ` +
        `Broadcast events are hints delivered at most once: after a reconnect ` +
        `or a gap the events in between are gone, so refetch in \`onResync\` ` +
        `(or use useChannelInvalidate).`,
    );
  }, [pattern, hasOn, hasResync]);

  return useChannelSubscription(
    pattern,
    (options.params ?? {}) as ChannelParamValues,
    {
      onEvent: (event, data) => {
        const handler = (configRef.current.on as Record<string, ((d: unknown) => void) | undefined>)?.[
          event
        ];
        handler?.(data);
      },
      onResync: () => configRef.current.onResync?.(),
    },
    config.enabled !== false,
  );
}

type GetPath = [keyof GetRPC] extends [never] ? string : keyof GetRPC & string;

/**
 * A query `useChannelInvalidate` refetches: an api path (its `:params`
 * filled from the channel's params, over the route's), or one with its own
 * params and a single search variant.
 */
export type InvalidatePath =
  | GetPath
  | {
      path: GetPath;
      params?: Record<string, string | number>;
      /** Only this search variant. Default: every cached variant. */
      search?: Record<string, string | number | boolean | null>;
    };

/**
 * Refetches `paths` on any event on the channel and on every resync. Only
 * the variants being rendered refetch now; the rest are marked stale.
 *
 * ```tsx
 * useChannelInvalidate("page.:pageId", { pageId }, ["/pages/:pageId", "/pages/:pageId/pictures"]);
 * ```
 */
export function useChannelInvalidate<P extends ChannelPattern>(
  pattern: P,
  params: ChannelParamsFor<P> | undefined,
  paths: readonly InvalidatePath[],
  config: { enabled?: boolean } = {},
): ChannelState {
  const { getResource } = useContext(QueryManagerContext);
  const routeParams = useParams();
  const channelParams = (params ?? {}) as ChannelParamValues;
  const latest = useRef({ paths, routeParams, channelParams, getResource });
  latest.current = { paths, routeParams, channelParams, getResource };

  const invalidate = () => {
    const { paths, routeParams, channelParams, getResource } = latest.current;
    for (const entry of paths) {
      const target = typeof entry === "string" ? { path: entry } : entry;
      const resolved = applyParams(target.path, {
        ...routeParams,
        ...channelParams,
        ...target.params,
      });
      const resource = getResource(resolved);
      const keys = target.search ? [toVariantKey(target.search)] : resource.variantKeys();
      for (const key of keys) resource.invalidate(key);
    }
  };

  return useChannelSubscription(
    pattern,
    channelParams,
    { onEvent: invalidate, onResync: invalidate },
    config.enabled !== false,
  );
}

/**
 * `useQuery`'s `live` option: the channel whose events and resyncs refetch
 * the query. A pattern without params (`"user"`), `[pattern, params]`, or
 * `{ channel, params }`.
 */
export type LiveChannel =
  | ChannelPattern
  | readonly [ChannelPattern, ChannelParamValues]
  | { channel: ChannelPattern; params?: ChannelParamValues };

export function resolveLiveChannel(
  live: LiveChannel | null | undefined | false,
): { pattern: string; params: ChannelParamValues } | null {
  if (!live) return null;
  if (typeof live === "string") return { pattern: live, params: {} };
  if (Array.isArray(live)) return { pattern: live[0], params: live[1] ?? {} };
  const object = live as { channel: string; params?: ChannelParamValues };
  return { pattern: object.channel, params: object.params ?? {} };
}
