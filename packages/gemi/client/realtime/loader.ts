import { loadLazy, loadedModule, type LazyModule } from "../lazyModule";
import type { QueryResource } from "../QueryResource";
import type { LiveChannel } from "./live";
import type { RealtimeClient, RealtimeOptions, RealtimeSocket } from "./RealtimeClient";

// The part of the realtime client every page carries: `gemi/client` reaches
// it through `useQuery`, `useMutation`, `init` and the auth hooks. The client
// itself (`./RealtimeClient`: the socket, the `gemi.v1` protocol, reconnects,
// heartbeats) and `useQuery`'s live subscription (`./live`) are loaded with a
// dynamic `import()` the first time something subscribes, so an app or a
// route that never subscribes downloads none of it (#891). Only type imports
// from those two here: a value import would put them back in the entry chunk,
// which "the published client, built into an app" in `packaging.test.ts`
// checks.

/**
 * The tab's client, once loaded and created (`tabClient` in
 * `./RealtimeClient` creates it), and the options it is created with.
 */
export const realtime: { client: RealtimeClient | null; options: RealtimeOptions } = {
  client: null,
  options: {},
};

/**
 * Sets the socket options (`init({ realtime })` calls it). Takes effect on
 * the next connection.
 */
export function configureRealtime(options: RealtimeOptions = {}) {
  Object.assign(realtime.options, options);
  realtime.client?.configure(realtime.options);
}

/** The tab's client if it is already loaded, else `null`. Never loads it. */
export function loadedRealtimeClient(): RealtimeClient | null {
  return realtime.client;
}

let loading: Promise<RealtimeClient> | null = null;

/** The lazily loaded client. Replaceable in tests, to simulate a failed load. */
export const lazyModules = {
  client: () => import("./RealtimeClient.js"),
};

/**
 * `./live`, loaded by the first live query. `<Page>` in `gemi/testing` sets
 * `current` up front, so a live query on a provided socket subscribes during
 * its effect, as it did before the module was split out.
 */
export const liveModule: LazyModule<Pick<typeof import("./live"), "followLive">> = {
  current: null,
  load: () => import("./live.js"),
};

/**
 * The tab's client, loading its module and creating it on first use. `null`
 * on the server. A failed load (a chunk gone after a deploy, the network) is
 * not kept, so a later subscription calls `import()` again; whether that
 * fetches anew is up to the browser, and the usual recovery is `init`'s
 * reload.
 */
export function loadRealtimeClient(): Promise<RealtimeClient> | null {
  if (typeof window === "undefined") return null;
  if (realtime.client) return Promise.resolve(realtime.client);
  loading ??= lazyModules
    .client()
    .then((module) => loadedModule(module).tabClient())
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/**
 * Follows `useQuery`'s `live` channel until the returned function is called.
 * `./live` loads on first use and does the rest, loading the socket client
 * in turn, so `useQuery` carries only this. `setOpen` reports `false` until
 * the channel is open.
 */
export function followLive(
  provided: RealtimeSocket | null,
  live: LiveChannel,
  resource: () => QueryResource,
  setOpen: (open: boolean) => void,
): () => void {
  // `undefined` until it starts, `null` once stopped.
  let stop: (() => void) | null | undefined;
  const start = (module: Pick<typeof import("./live"), "followLive">) => {
    if (stop === undefined) stop = module.followLive(provided, live, resource, setOpen);
  };
  if (liveModule.current) start(liveModule.current);
  // A failed load leaves the channel closed, so the query keeps polling.
  else loadLazy(liveModule).then(start).catch(() => {});
  return () => {
    stop?.();
    stop = null;
    setOpen(false);
  };
}

/**
 * Reconnects the tab's socket, if it has one, so its channels are authorized
 * as the current session. The auth hooks call it after signing in or out.
 * Never loads or creates the client.
 */
export function reconnectRealtime() {
  realtime.client?.reconnect();
}

/**
 * The open socket's id, for the `X-Gemi-Socket` header, or `null`. Never
 * loads or creates the client.
 */
export function currentSocketId(): string | null {
  return realtime.client?.socketId ?? null;
}
