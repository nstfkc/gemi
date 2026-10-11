import type { QueryResource } from "../QueryResource";
import type { ChannelPattern } from "../useChannel";
import { EVENT_COALESCE_MS } from "./useChannelSubscription";
import type { ChannelParamValues, RealtimeSocket } from "./RealtimeClient";

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

/**
 * `useQuery`'s `live` subscription, loaded on first use by `followLive` in
 * `./loader` (#891). The channel's events refetch every cached variant of the
 * query (the rendered ones now), a burst of them once per
 * `EVENT_COALESCE_MS`; a resync refetches at once. `setOpen` follows whether
 * the channel is open, which pauses the query's polling.
 */
export function subscribeLive(
  socket: RealtimeSocket,
  live: LiveChannel,
  resource: () => QueryResource,
  setOpen: (open: boolean) => void,
): () => void {
  const channel = resolveLiveChannel(live);
  if (!channel) return () => {};
  const refresh = () => {
    const target = resource();
    for (const key of target.variantKeys()) target.invalidate(key);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = socket.subscribe(channel.pattern, channel.params, {
    onEvent: () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, EVENT_COALESCE_MS);
    },
    onResync: refresh,
    onStatus: (status) => setOpen(status === "open"),
  });
  return () => {
    if (timer) clearTimeout(timer);
    release();
  };
}
