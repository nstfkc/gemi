import {
  createContext,
  type PropsWithChildren,
  type ReactElement,
  useMemo,
  useRef,
} from "react";
import { QueryResource } from "./QueryResource";
import type { RetryDelayOption, RetryOption } from "./retryPolicy";

/** One streamed query payload: `[path, variantKey, data]`. */
type StreamedQueryPayload = [string, string, any];

/**
 * App-wide `useQuery` defaults, threaded from `createRoot(RootLayout, {
 * queryConfig })` (and `init` on the client). Resolution order is per-call
 * config → these defaults → framework defaults, so a call site always wins.
 * Only keys with app-wide meaning are accepted — `lazy`, `fallbackData` and
 * `refetchUntil` stay call-site-only. Framework-internal hooks (`useUser`,
 * `useSignIn`) never see these — `useUser` has its own `user` key.
 */
export interface QueryConfig {
  /**
   * App-wide suspense switch. `suspense: false` makes every unconfigured
   * `useQuery` behave like pre-0.49: `loading` flags instead of suspension,
   * errors returned instead of thrown. Pair it with the `GemiQueryDefaults`
   * module augmentation so `data`'s nullability matches.
   */
  suspense?: boolean;
  /** How long cached data stays fresh before a read revalidates it, in ms. */
  staleTime?: number;
  keepPreviousData?: boolean;
  /**
   * Background retries for failed `suspense: false` queries. Default `3`:
   * network failures, 408, 429 and 5xx, with exponential backoff; other 4xx
   * are never retried. See `useQuery`'s `retry`.
   */
  retry?: RetryOption;
  /** The wait before each retry, in ms, or `(failureCount, error) => ms`. */
  retryDelay?: RetryDelayOption;
  /** @deprecated Use `retryDelay`. The base of the default backoff. */
  retryIntervalOnError?: number;
  refreshInterval?: number;
  /**
   * Revalidate every query when the tab comes back to the foreground, gated by
   * `staleTime`. Off by default.
   */
  revalidateOnFocus?: boolean;
  /**
   * Minimum gap between two focus revalidations of the same query, in ms
   * (default 5000).
   */
  focusThrottleInterval?: number;
  /**
   * Defaults for `useUser()`'s `/auth/me` query, which ignores the keys above.
   * E.g. `{ staleTime: 30 * 60_000 }` to revalidate the signed-in user at most
   * every half hour — `useSignIn`/`useSignOut` still update it immediately.
   */
  user?: UserQueryConfig;
}

/**
 * The `useUser()` settings an app may change — per call or app-wide through
 * `queryConfig.user`. Its `suspense: false` and `fallbackData` stay pinned.
 */
export interface UserQueryConfig {
  staleTime?: number;
  retry?: RetryOption;
  retryDelay?: RetryDelayOption;
  revalidateOnFocus?: boolean;
  focusThrottleInterval?: number;
  refreshInterval?: number;
}

export const QueryConfigContext = createContext<QueryConfig | null>(null);

/**
 * The runtime mirror of the `QueryConfig` type: TS excess-property checking
 * only fires on fresh object literals, so a dynamically built (or plain-JS)
 * config could smuggle call-site-only keys (`lazy`, `fallbackData`,
 * `refetchUntil`) into every query. The provider picks these keys — and only
 * these — before the value enters the context. Keys whose value is
 * `undefined` are dropped too, so an absent value (e.g. an unset env-derived
 * `staleTime`) falls through to the framework default instead of shadowing it.
 */
const APP_WIDE_QUERY_CONFIG_KEYS = [
  "suspense",
  "staleTime",
  "keepPreviousData",
  "retry",
  "retryDelay",
  "retryIntervalOnError",
  "refreshInterval",
  "revalidateOnFocus",
  "focusThrottleInterval",
] as const satisfies ReadonlyArray<keyof QueryConfig>;

export const USER_QUERY_CONFIG_KEYS = [
  "staleTime",
  "retry",
  "retryDelay",
  "revalidateOnFocus",
  "focusThrottleInterval",
  "refreshInterval",
] as const satisfies ReadonlyArray<keyof UserQueryConfig>;

/** Copy the listed keys whose value is defined. */
export function pickDefined<T extends object, K extends keyof T>(
  source: T | null | undefined,
  keys: ReadonlyArray<K>,
): Pick<T, K> {
  const picked = {} as Pick<T, K>;
  if (!source) return picked;
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

export function pickAppWideQueryConfig(
  queryConfig: QueryConfig | null | undefined,
): QueryConfig | null {
  if (!queryConfig) return null;
  const picked: QueryConfig = pickDefined(
    queryConfig,
    APP_WIDE_QUERY_CONFIG_KEYS,
  );
  if (queryConfig.user) {
    picked.user = pickDefined(queryConfig.user, USER_QUERY_CONFIG_KEYS);
  }
  return picked;
}

export type PrefetchedData = Record<string, Record<string, any>>;

export interface QueryManagerContextValue {
  getResource: (
    key: string,
    initialState?: Record<string, any>,
  ) => QueryResource;
  /**
   * `streamed`: the data came from a streamed server payload, which readers
   * that don't suspend leave out while hydrating (`peekForHydration`).
   */
  hydrate: (prefetchedData?: PrefetchedData | null, streamed?: boolean) => void;
  clearErrors: () => void;
}

export const QueryManagerContext = createContext<QueryManagerContextValue>({
  getResource: (key: string, initialState: Record<string, any> = {}) => {
    return new QueryResource(key, initialState);
  },
  hydrate: () => {},
  clearErrors: () => {},
});

/**
 * A query cache: resources by path, created on first read and kept for the
 * cache's lifetime. The provider below holds one per app; the islands of a
 * static page share another (`ISLAND_QUERIES_KEY`).
 */
function createQueryManager(): QueryManagerContextValue {
  const resources = new Map<string, QueryResource>();
  return {
    getResource(key, initialState) {
      let resource = resources.get(key);
      if (!resource) {
        resource = new QueryResource(key, initialState ?? {});
        resources.set(key, resource);
      }
      return resource;
    },
    // Resources are cached by path for the lifetime of the app, so
    // `initialState` above only ever applies to the first load. Every
    // navigation ships a fresh `prefetchedData` payload that has to be pushed
    // into the existing resources, otherwise the components mounting on the
    // new surface refetch it over `/api`.
    hydrate(prefetchedData, streamed = false) {
      if (!prefetchedData) return;
      for (const [key, initialState] of Object.entries(prefetchedData)) {
        if (!initialState || typeof initialState !== "object") continue;
        let resource = resources.get(key);
        if (!resource) {
          resource = new QueryResource(key, {});
          resources.set(key, resource);
        }
        resource.hydrate(initialState, streamed);
      }
    },
    // Used by the route-level error boundary's reset: without this, the
    // retried render would read the stored failure back out of the cache and
    // re-throw.
    clearErrors() {
      for (const resource of resources.values()) {
        resource.clearError();
      }
    },
  };
}

/** The key the island runtime (`h`) finds the islands' query cache under. */
export const ISLAND_QUERIES_KEY = "gemi.islandQueries";

/**
 * The query cache the islands of a static page share (#1155), on
 * `globalThis` for the island runtime, which has no imports of gemi's: it
 * wraps each island in `Provider`, and before hydrating one `seed`s the cache
 * with the document's `gemi-island-queries` block, so `useQuery` hydrates
 * with the data the server rendered and fetches nothing. Without it an
 * island's `useQuery` had no cache at all (a new resource per render).
 * Registered when `gemi/client` loads, so an island that never imports it
 * (and so reads no query) is left as it was.
 */
export interface IslandQueries {
  seed: (prefetchedData: PrefetchedData) => void;
  Provider: (props: PropsWithChildren) => ReactElement;
}

if (typeof window !== "undefined") {
  const registry = globalThis as Record<symbol, unknown>;
  if (!registry[Symbol.for(ISLAND_QUERIES_KEY)]) {
    const manager = createQueryManager();
    const islandQueries: IslandQueries = {
      seed: manager.hydrate,
      Provider: ({ children }) => (
        <QueryManagerContext.Provider value={manager}>{children}</QueryManagerContext.Provider>
      ),
    };
    registry[Symbol.for(ISLAND_QUERIES_KEY)] = islandQueries;
  }
}

export const QueryManagerProvider = ({
  children,
  queryConfig = null,
}: PropsWithChildren<{ queryConfig?: QueryConfig | null }>) => {
  // Sanitized once at the choke point every query reads through, so the
  // "only app-wide keys" contract holds at runtime, not just in the types.
  const appQueryConfig = useMemo(
    () => pickAppWideQueryConfig(queryConfig),
    [queryConfig],
  );

  const managerRef = useRef<QueryManagerContextValue | null>(null);
  managerRef.current ??= createQueryManager();
  const value = managerRef.current;
  const { hydrate } = value;

  // Streaming SSR delivers late-resolving queries as inline
  // `__GEMI_STREAM__.push([path, variant, data])` scripts interleaved with
  // React's chunks. Payloads that ran before this rendered sit buffered in a
  // plain array; from here on, `push` hydrates directly — and `hydrate`
  // settles any reader suspended on that variant.
  //
  // Drained synchronously during the FIRST render, not in an effect:
  // suspension happens during the render phase, so a segment hydrating in
  // this very pass must already find its streamed data in the cache — an
  // effect-timed drain would let it suspend and start a duplicate `/api`
  // fetch for data the document already carries. Safe here: it runs once
  // (idempotent under StrictMode's double-invoke), and nothing is subscribed
  // to the store yet, so no render is invalidated mid-pass.
  const drainedStreamRef = useRef(false);
  if (typeof window !== "undefined" && !drainedStreamRef.current) {
    drainedStreamRef.current = true;
    const w = window as unknown as {
      __GEMI_STREAM__?:
        | StreamedQueryPayload[]
        | { push: (p: StreamedQueryPayload) => void };
    };
    const adopt = ([path, variantKey, data]: StreamedQueryPayload) => {
      hydrate({ [path]: { [variantKey]: data } }, true);
    };
    const buffered = Array.isArray(w.__GEMI_STREAM__) ? w.__GEMI_STREAM__ : [];
    w.__GEMI_STREAM__ = { push: adopt };
    for (const payload of buffered) {
      adopt(payload);
    }
  }

  return (
    <QueryManagerContext.Provider value={value}>
      <QueryConfigContext.Provider value={appQueryConfig}>
        {children}
      </QueryConfigContext.Provider>
    </QueryManagerContext.Provider>
  );
};
