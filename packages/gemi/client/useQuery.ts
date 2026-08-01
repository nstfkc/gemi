import {
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { RPC } from "./rpc";
import type { NestedPrettify } from "../utils/type";

import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import { QueryConfigContext, QueryManagerContext } from "./QueryManagerContext";
import { ServerQueryContext } from "./ServerQueryContext";
import { DEFAULT_STALE_TIME } from "./QueryResource";
import { applyParams } from "../utils/applyParams";
import type { UrlParser } from "./types";
import { omitNullishValues } from "../utils/omitNullishValues";
import { useParams } from "./useParams";
import { useRouteData } from "./useRouteData";
import { isPlainObject } from "./isPlainObject";

interface Config<T> {
  fallbackData?: T;
  /**
   * When true (the default), a variant change keeps rendering the previous
   * variant's data while the new one loads. Under suspense this reads through
   * a deferred variant key, so changing `search`/`params` never flashes the
   * segment fallback and needs no `startTransition` at the call site — the
   * pending window is exposed as `loading: true`. Set to `false` to get the
   * suspend-on-variant-change semantics back (e.g. tab-like switches where
   * stale rows would mislead). First mount always suspends either way.
   */
  keepPreviousData?: boolean;
  retryIntervalOnError?: number;
  refreshInterval?: number;
  /** How long cached data stays fresh before a read revalidates it, in ms. */
  staleTime?: number;
  debug?: boolean;
  lazy?: boolean;
  /**
   * When true (the default), a query with no cached data suspends the nearest
   * `Suspense` boundary instead of returning `loading: true`, and an HTTP
   * failure throws into the nearest error boundary. `lazy: true` implies
   * `suspense: false`.
   */
  suspense?: boolean;
  refetchUntil?: (data: T, duration: number) => number;
}

type WithOptionalValues<T> = {
  [K in keyof T]: T[K] | null;
};

const defaultConfig: Config<any> = {
  fallbackData: null,
  keepPreviousData: true,
  retryIntervalOnError: 10000,
  refreshInterval: 999999,
  staleTime: DEFAULT_STALE_TIME,
  debug: false,
  lazy: false,
  suspense: true,
};

type GetRPC = {
  [K in keyof RPC as K extends `GET:${infer P}` ? P : never]: RPC[K];
};

type Data<T extends keyof GetRPC> =
  GetRPC[T] extends ApiRouterHandler<any, infer Data, any>
    ? UnwrapPromise<Data>
    : never;

type Input<T extends keyof GetRPC> =
  GetRPC[T] extends ApiRouterHandler<infer I, any, any> ? I : never;

type QueryOptions<T extends keyof GetRPC> = {
  search?: Partial<WithOptionalValues<Input<T>>>;
};

type Error = Record<string, unknown>;

const defaultOptions: QueryOptions<any> & { params?: Record<string, any> } = {
  params: {} as Record<string, string>,
  search: {} as Record<string, string>,
};

export type QueryResult<T extends keyof GetRPC> = NestedPrettify<Data<T> & {}>;

type Options<T extends keyof GetRPC> = {
  search?: Record<string, string | number | boolean | null>;
  params?: Partial<UrlParser<`${T & string}`>>;
};

interface QueryReturn<T extends keyof GetRPC, D> {
  data: D;
  loading: boolean;
  error: Error;
  mutate: {
    (fn?: NestedPrettify<Data<T>>): void;
    (fn?: (data: NestedPrettify<Data<T>>) => NestedPrettify<Data<T>>): void;
  };
  trigger: () => void;
  prefetch: () => void;
  refetch: () => void;
  version: number;
}

/**
 * A suspense-enabled query never renders without data, so `data` is
 * non-nullable. Opting out — `suspense: false` or `lazy: true` — brings back
 * the `loading` flag and with it a `data` that can be `undefined`.
 */
interface SuspenseConfig<T> extends Omit<Config<T>, "suspense" | "lazy"> {
  suspense?: true;
  lazy?: false;
}

/** A per-call `suspense: true` opt-in — wins over an app-wide `suspense: false`. */
interface ExplicitSuspenseConfig<T> extends Omit<
  Config<T>,
  "suspense" | "lazy"
> {
  suspense: true;
  lazy?: false;
}

/**
 * The type-level mirror of a provider-level `queryConfig: { suspense: false }`.
 * The `useQuery` overloads reflect the call site only — they cannot see the
 * value threaded through `createRoot` — so an app that turns suspense off
 * app-wide flips the default `data` nullability with the same
 * module-augmentation switch RPC types use:
 *
 * ```ts
 * declare module "gemi/client" {
 *   interface GemiQueryDefaults {
 *     suspense: false;
 *   }
 * }
 * ```
 *
 * A per-call `suspense: true` still narrows `data` back to non-nullable.
 */
export interface GemiQueryDefaults {}

type DefaultData<T extends keyof GetRPC> = GemiQueryDefaults extends {
  suspense: false;
}
  ? NestedPrettify<Data<T>> | undefined
  : NestedPrettify<Data<T>>;

export function useQuery<T extends keyof GetRPC>(
  url: T,
  options: Options<T> | undefined,
  config: ExplicitSuspenseConfig<Data<T>>,
): QueryReturn<T, NestedPrettify<Data<T>>>;
export function useQuery<T extends keyof GetRPC>(
  url: T,
  options?: Options<T>,
  config?: SuspenseConfig<Data<T>>,
): QueryReturn<T, DefaultData<T>>;
export function useQuery<T extends keyof GetRPC>(
  url: T,
  options?: Options<T>,
  config?: Config<Data<T>>,
): QueryReturn<T, NestedPrettify<Data<T>> | undefined>;
export function useQuery<T extends keyof GetRPC>(
  url: T,
  ...args: [options?: Options<T>, config?: Config<Data<T>>]
) {
  const [options, config] = args;
  // Resolution order: per-call config → provider `queryConfig` → framework
  // defaults. The first two merge here; `useFrameworkQuery` applies the last.
  // Only *defined* per-call keys participate: a key explicitly set to
  // `undefined` (`{ suspense: cond ? true : undefined }`, forwarding an
  // optional prop) must fall through to the provider default, not clobber it
  // — a plain spread would copy the `undefined` over it. The provider value
  // is already sanitized at the provider (see `QueryManagerProvider`).
  const queryConfig = useContext(QueryConfigContext);
  const merged: Config<Data<T>> = { ...queryConfig };
  if (config) {
    for (const key of Object.keys(config) as Array<keyof Config<Data<T>>>) {
      if (config[key] !== undefined) {
        (merged as Record<string, unknown>)[key] = config[key];
      }
    }
  }
  return useFrameworkQuery(url, options, merged);
}

/**
 * `useQuery` minus the app's provider-level `queryConfig`: per-call config
 * resolves straight against the framework defaults. Framework-internal hooks
 * (`useUser`'s `suspense: false`, `useSignIn`'s `lazy`) build on this so an
 * app-wide `queryConfig` can never change their semantics. Deliberately not
 * exported from the package root.
 */
export function useFrameworkQuery<T extends keyof GetRPC>(
  url: T,
  ...args: [options?: Options<T>, config?: Config<Data<T>>]
): QueryReturn<T, NestedPrettify<Data<T>> | undefined> {
  const _params = useParams();
  const [_options = defaultOptions, _config = defaultConfig] = args;
  const options = { ...defaultOptions, ..._options };
  const config = { ...defaultConfig, ..._config };
  const suspense = config.suspense !== false && !config.lazy;
  const params =
    "params" in options ? { ..._params, ...options.params } : _params;
  const search = "search" in options ? (options.search ?? {}) : {};
  const { getResource } = useContext(QueryManagerContext);
  const serverQueries = useContext(ServerQueryContext);
  const currentPath = applyParams(url, params);
  const searchParams = new URLSearchParams(omitNullishValues(search));
  searchParams.sort();
  const currentVariantKey = searchParams.toString();
  // `keepPreviousData` under suspense: read through deferred keys so a
  // variant change never suspends the committed tree. The urgent render keeps
  // showing the previous variant's data; React re-renders in the background
  // with the new keys, suspends *that* attempt only (no fallback flash), and
  // commits when the data lands — no `startTransition` needed at the call
  // site. First mount is unchanged: deferred and current keys are equal, so
  // an uncached query suspends into the segment fallback as today. Both hooks
  // run unconditionally (hook order); the values are only *used* when
  // deferring applies.
  const deferredPath = useDeferredValue(currentPath);
  const deferredVariantKey = useDeferredValue(currentVariantKey);
  const deferVariant = suspense && config.keepPreviousData;
  const normalPath = deferVariant ? deferredPath : currentPath;
  const variantKey = deferVariant ? deferredVariantKey : currentVariantKey;
  // The pending signal for pager UI: true while the visible data belongs to
  // the previous variant and the new one is still loading in the background.
  const isDeferred =
    normalPath !== currentPath || variantKey !== currentVariantKey;
  const { prefetchedData } = useRouteData();
  // `fallbackData` is a single variant's value, so it seeds under this
  // query's variant key; `prefetchedData[normalPath]` is already the full
  // `{ [variantKey]: data }` map the server produced.
  const seed =
    config.fallbackData != null
      ? { [variantKey]: config.fallbackData }
      : prefetchedData?.[normalPath];
  // A memoized map lookup on the provider's ref: stable and cheap, so the
  // resource is derived every render — a params change swaps it in the same
  // render pass instead of flashing through an effect.
  const resource = getResource(normalPath, seed ?? undefined);
  const lazy = config.lazy;

  const configRef = useRef(config);
  configRef.current = config;

  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const retryIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryingMap = useRef<Map<string, boolean>>(new Map());
  const fetchedRef = useRef(!lazy);
  const refetchUntilTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const refetchUntilDurationRef = useRef(0);
  const prefetchedRef = useRef(false);

  const subscribe = useCallback(
    (onStoreChange: () => void) => resource.store.subscribe(onStoreChange),
    [resource],
  );
  // `peek` hands back the object stored in the map — its identity only
  // changes on a real write, so the snapshot is stable across render
  // attempts. Also the server snapshot: SSR renders whatever the prefetch
  // payload seeded, and never fetches.
  //
  // uSES and transitions: store updates are always urgent, so a write landing
  // mid-transition restarts the pending transition — wasted work, never wrong
  // UI. Exposure is kept small by design: render-phase reads never write the
  // store synchronously (fetches are silent), and a suspended component has no
  // subscription — it is woken by its thrown promise, not the store. The
  // navigation-shaped consequences are pinned in `useQuery.transition.test.tsx`.
  const getSnapshot = useCallback(
    () => resource.peek(variantKey),
    [resource, variantKey],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // `keepPreviousData`: remember the last snapshot that had data, and show it
  // whenever the current one is loading without data (e.g. a variant change
  // with `suspense: false`). Presence is `hasData`, never `data`'s truthiness
  // — `null`/`0`/`false`/`""` are legitimate response bodies.
  const lastDataRef = useRef(snapshot?.hasData ? snapshot : null);
  useEffect(() => {
    if (snapshot?.hasData) {
      lastDataRef.current = snapshot;
    }
  }, [snapshot]);

  let state = snapshot;
  if (
    config.keepPreviousData &&
    !snapshot?.hasData &&
    snapshot?.loading &&
    lastDataRef.current
  ) {
    state = { ...lastDataRef.current, loading: true };
  }

  // The render-phase read for the suspense path. Only when there is nothing
  // to show — data in hand always renders, and revalidation stays where it
  // was (the mount effect below). Both reads dedupe across the render
  // attempts React discards, so this is safe to hit on every attempt.
  //
  // On a streaming server render the read goes to the request's
  // `ServerQueryStore` instead of the client resource: a prefetched query is
  // already in flight there and is joined, an undiscovered one starts now
  // (the store logs the late-discovery hint when that cost something).
  let readPromise: Promise<void> | undefined;
  let serverError: unknown;
  if (suspense && !state?.hasData && !state?.error) {
    if (typeof window === "undefined") {
      if (serverQueries) {
        const entry = serverQueries.ensure(url, { params, search });
        if (entry.status === "resolved") {
          state = {
            loading: false,
            data: entry.data,
            hasData: true,
            error: null,
            version: 0,
          };
        } else if (entry.status === "rejected") {
          serverError = entry.error;
        } else {
          readPromise = entry.promise;
        }
      }
    } else {
      readPromise = resource.read(variantKey, config.staleTime).promise;
    }
  }

  if (
    suspense &&
    typeof window === "undefined" &&
    !serverQueries &&
    !state?.hasData &&
    process.env.NODE_ENV !== "production"
  ) {
    const searchHint = variantKey
      ? `, { search: ${JSON.stringify(Object.fromEntries(searchParams))} }`
      : "";
    console.warn(
      `[gemi] useQuery("${url}") rendered on the server without data. ` +
        `The server never fetches, so this page ships without it and the ` +
        `client suspends after hydration. Add ` +
        `\`Query.prefetch("${url}"${searchHint})\` to the route's view handler.`,
    );
  }

  const retry = useCallback(
    (vk: string) => {
      if (!retryingMap.current.get(vk)) {
        if (configRef.current.debug) console.log("retrying", vk);
        retryingMap.current.set(vk, true);
        retryIntervalRef.current = setTimeout(() => {
          resource.getVariant(vk, configRef.current.staleTime);
          retryingMap.current.set(vk, false);
        }, configRef.current.retryIntervalOnError);
      }
    },
    [resource],
  );

  // Mount / variant-change revalidation — unchanged semantics: `getVariant`
  // fetches when the variant is missing or stale, and now joins an in-flight
  // render-initiated read instead of racing it.
  useEffect(() => {
    if (fetchedRef.current) {
      resource.getVariant(variantKey, configRef.current.staleTime);
    }
    return () => {
      clearTimeout(retryIntervalRef.current);
    };
  }, [variantKey, resource]);

  // With `suspense: false` an error is returned and retried in the
  // background; under suspense it throws below instead.
  useEffect(() => {
    if (!suspense && snapshot?.error) {
      retry(variantKey);
    }
  }, [snapshot, suspense, retry, variantKey]);

  useEffect(() => {
    const cfg = configRef.current;
    if (!cfg.refetchUntil) return;
    if (snapshot && !snapshot.loading && snapshot.hasData && !snapshot.error) {
      const nextDuration = cfg.refetchUntil(
        snapshot.data,
        refetchUntilDurationRef.current,
      );
      if (nextDuration > 0) {
        refetchUntilDurationRef.current = nextDuration;
        refetchUntilTimerRef.current = setTimeout(() => {
          resource.refetch(variantKey);
        }, nextDuration);
      } else {
        refetchUntilDurationRef.current = 0;
      }
    }
    return () => {
      if (refetchUntilTimerRef.current) {
        clearTimeout(refetchUntilTimerRef.current);
      }
    };
  }, [snapshot, resource, variantKey]);

  const handleReload = useCallback(() => {
    if (configRef.current.debug) {
      console.log("Reloading query for", variantKey);
    }
    const data = resource.getVariant(
      variantKey,
      configRef.current.staleTime,
    ).data;
    resource.mutate(variantKey, () => data);
  }, [variantKey, resource]);

  useEffect(() => {
    if (!fetchedRef.current) return;
    refreshIntervalRef.current = setInterval(() => {
      handleReload();
    }, config.refreshInterval);

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [config.refreshInterval, handleReload]);

  useEffect(() => {
    // Feature-checked per method: vitest's `import.meta.hot` shim has `on`
    // but not `off`.
    // @ts-ignore
    if (typeof import.meta.hot?.on === "function") {
      // @ts-ignore
      import.meta.hot.on("http-reload", handleReload);
    }
    return () => {
      // @ts-ignore
      if (typeof import.meta.hot?.off === "function") {
        // @ts-ignore
        import.meta.hot.off("http-reload", handleReload);
      }
    };
  }, [handleReload]);

  const trigger = useCallback(() => {
    fetchedRef.current = true;
    const store = resource.store.getValue();
    const variant = store.get(variantKey);
    if (!variant || (!variant.loading && !variant.hasData)) {
      resource.refetch(variantKey);
    }
  }, [resource, variantKey]);

  const prefetch = useCallback(() => {
    if (prefetchedRef.current) return;
    prefetchedRef.current = true;
    fetchedRef.current = true;
    // `read`, not `refetch`: a suspending read that follows joins this
    // request instead of racing it, and fresh data is a no-op.
    resource.read(variantKey, configRef.current.staleTime);
  }, [resource, variantKey]);

  const refetch = useCallback(() => {
    fetchedRef.current = true;
    resource.refetch(variantKey);
  }, [resource, variantKey]);

  function mutate(fn?: NestedPrettify<Data<T>>): void;
  function mutate(
    fn?: (data: NestedPrettify<Data<T>>) => NestedPrettify<Data<T>>,
  ): void;
  function mutate(fn?: any) {
    if (!fn) {
      fetchedRef.current = true;
      resource.refetch(variantKey);
      return;
    }
    return resource.mutate(variantKey, (data: any) => {
      // `null` is a legitimate cached body; only `undefined` means the query
      // hasn't produced anything (and `mutate` refetches instead of calling
      // this in that case).
      if (data === undefined) {
        console.warn("Mutate function called before the query.");
        return data;
      }

      // The callback's return value *replaces* the cached data. The type checks
      // below only ensure the shape matches so a stray value can't corrupt the
      // cache; they do not merge or append.
      const updatedData = typeof fn === "function" ? fn(data) : fn;

      if (isPlainObject(data)) {
        if (isPlainObject(updatedData)) {
          return updatedData;
        }
        throw new Error(
          "Mutate function must return an object when the current data is an object.",
        );
      }

      if (Array.isArray(data)) {
        if (Array.isArray(updatedData)) {
          return updatedData;
        }
        throw new Error(
          "Mutate function must return an array when the current data is an array.",
        );
      }

      if (typeof data !== typeof updatedData) {
        throw new Error(
          "Mutate function must return the same type as the current data.",
        );
      }

      return updatedData;
    });
  }

  // Suspend last, after every hook has run: the attempt React discards ran
  // them all, and the retry re-runs them identically. The promise is *thrown*
  // rather than passed to `use()` — the thenable-throw protocol is what
  // React's ping-and-retry machinery is built around (React.lazy, SWR, React
  // Query), whereas `use()` on a client-created promise is documented as
  // unsupported outside a Suspense-compatible framework and React never
  // retries it. A streaming server render takes the same paths: a pending
  // entry suspends (React streams the fallback and resumes on settle), and a
  // rejected one throws so the segment falls back to client rendering, where
  // the browser's own fetch surfaces the error into the boundary.
  if (suspense) {
    if (serverError) {
      throw serverError;
    }
    if (state?.error && !state?.hasData) {
      throw state.error;
    }
    if (!state?.hasData && readPromise) {
      throw readPromise;
    }
  }

  return {
    data: state?.data as NestedPrettify<Data<T>>,
    loading: isDeferred || (state?.loading ?? !lazy),
    error: state?.error as Error,
    mutate,
    trigger,
    prefetch,
    refetch,
    version: state?.version as number,
  };
}
