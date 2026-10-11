import type { ChannelParamValues, RealtimeClient, RealtimeOptions } from "./RealtimeClient";

// The part of the realtime client every page carries. `RealtimeClient` itself
// (the socket, the `gemi.v1` protocol, reconnects, heartbeats) is loaded with a
// dynamic `import()` the first time a channel hook subscribes, so an app or a
// route that never subscribes downloads none of it. Only type imports from
// `./RealtimeClient` here: a value import would put the whole module back in
// the entry chunk. `client-bundle` in `packaging.test.ts` checks that.

/** `pattern` and its params, canonical: two hooks on one channel share a `sub`. */
export function channelKey(pattern: string, params: ChannelParamValues): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => [key, String(params[key])]);
  return `${pattern}\u0000${JSON.stringify(sorted)}`;
}

let configured: RealtimeOptions = {};
let instance: RealtimeClient | null = null;
let loading: Promise<RealtimeClient> | null = null;

/**
 * Sets the socket options (`init({ realtime })` calls it). Takes effect on
 * the next connection.
 */
export function configureRealtime(options: RealtimeOptions = {}) {
  configured = { ...configured, ...options };
  instance?.configure(configured);
}

/** The tab's client if it is already loaded, else `null`. Never loads it. */
export function loadedRealtimeClient(): RealtimeClient | null {
  return instance;
}

/**
 * The tab's client, loading its module and creating it on first use. `null`
 * on the server. A failed load (a chunk gone after a deploy, the network) is
 * not cached: the next subscription tries again.
 */
export function loadRealtimeClient(): Promise<RealtimeClient> | null {
  if (typeof window === "undefined") return null;
  if (instance) return Promise.resolve(instance);
  loading ??= import("./RealtimeClient.js").then(
    ({ RealtimeClient }) => (instance ??= new RealtimeClient(configured)),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * Reconnects the tab's socket, if it has one, so its channels are authorized
 * as the current session. The auth hooks call it after signing in or out.
 * Never loads or creates the client.
 */
export function reconnectRealtime() {
  instance?.reconnect();
}

/**
 * The open socket's id, for the `X-Gemi-Socket` header, or `null`. Never
 * loads or creates the client.
 */
export function currentSocketId(): string | null {
  return instance?.socketId ?? null;
}
