import type { QueryResource } from "../QueryResource";
import type { LiveChannel } from "./live";
import type {
  ChannelParamValues,
  RealtimeClient,
  RealtimeOptions,
  RealtimeSocket,
} from "./RealtimeClient";

// The part of the realtime client every page carries: `gemi/client` reaches
// it through `useQuery`, `useMutation`, `init` and the auth hooks. The client
// itself (`./RealtimeClient`: the socket, the `gemi.v1` protocol, reconnects,
// heartbeats) and `useQuery`'s live subscription (`./live`) are loaded with a
// dynamic `import()` the first time something subscribes, so an app or a
// route that never subscribes downloads none of it (#891). Only type imports
// from those two here: a value import would put them back in the entry chunk,
// which "the published client, built into an app" in `packaging.test.ts`
// checks.

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
 * What a lazy `import()` resolved to, or a thrown error when it is missing.
 * Vite's preload helper resolves the `import()` to `undefined` instead of
 * rejecting when a `vite:preloadError` listener handled the failure (`init`'s
 * chunk-load recovery does, as it starts a reload): treated as a failed load.
 */
export function loadedModule<T>(module: T | undefined): T {
  if (!module) throw new Error("[gemi] A lazily loaded chunk is unavailable.");
  return module;
}

/** The lazily loaded modules. Replaceable in tests, to simulate a failed load. */
export const lazyModules = {
  client: () => import("./RealtimeClient.js"),
  live: () => import("./live.js"),
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
  if (instance) return Promise.resolve(instance);
  loading ??= lazyModules
    .client()
    .then((module) => (instance ??= new (loadedModule(module).RealtimeClient)(configured)))
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

type LiveModule = typeof import("./live");
let liveModule: LiveModule | null = null;

/**
 * Makes `./live` available without loading it: `<Page>` in `gemi/testing`
 * passes it, so a live query on a provided socket subscribes during its
 * effect, as it did before the module was split out.
 */
export function provideLiveModule(module: LiveModule) {
  liveModule = module;
}

/**
 * Follows `useQuery`'s `live` channel until the returned function is called.
 * `./live` and the socket client are loaded on first use, so `useQuery`
 * carries only this; once both are loaded later queries subscribe at once.
 * `setOpen` reports `false` until the channel is open.
 */
export function followLive(
  provided: RealtimeSocket | null,
  live: LiveChannel,
  resource: () => QueryResource,
  setOpen: (open: boolean) => void,
): () => void {
  let cancelled = false;
  let stop: (() => void) | null = null;
  const start = (module: LiveModule, socket: RealtimeSocket | null) => {
    liveModule = module;
    if (!cancelled && socket) stop = module.subscribeLive(socket, live, resource, setOpen);
  };
  const socket = provided ?? instance;
  if (liveModule && socket) {
    start(liveModule, socket);
  } else {
    Promise.all([liveModule ?? lazyModules.live(), socket ?? loadRealtimeClient()])
      .then(([module, socket]) => start(loadedModule(module), socket))
      // A failed load leaves the channel closed, so the query keeps polling.
      .catch(() => {});
  }
  return () => {
    cancelled = true;
    stop?.();
    setOpen(false);
  };
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
