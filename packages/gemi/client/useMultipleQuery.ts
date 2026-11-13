import {
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { NestedPrettify } from "../utils/type";
import { QueryConfigContext, QueryManagerContext } from "./QueryManagerContext";
import type { QueryResource } from "./QueryResource";
import { ServerQueryContext } from "./ServerQueryContext";
import { useParams } from "./useParams";
import { useRouteData } from "./useRouteData";
import { RealtimeContext } from "./realtime/RealtimeContext";
import { followLive } from "./realtime/loader";
import {
  defaultConfig,
  defaultOptions,
  type Config,
  type Data,
  type GemiQueryDefaults,
  type GetRPC,
  type Options,
} from "./useQuery";
import {
  createPollState,
  mergeDefinedConfig,
  mutateQuery,
  onHttpReload,
  reloadQuery,
  resolveQueryTarget,
  retryFailedQuery,
  retryWhenOnline,
  revalidateOnFocus,
  stepPoll,
  stopPoll,
  warnUnprefetched,
  type FocusState,
  type PollState,
} from "./queryEffects";

/**
 * A key's options: `useQuery`'s config minus `lazy` (a query that waits for a
 * `trigger` does not load with the others; give it its own `useQuery`).
 */
export type MultipleQueryConfig<T> = Omit<Config<T>, "lazy">;

/** One key of `useMultipleQuery`: `[path, options?, config?]`, like `useQuery`'s arguments. */
export type MultipleQueryEntry<P extends keyof GetRPC = keyof GetRPC> =
  | readonly [path: P]
  | readonly [path: P, options: Options<P> | undefined]
  | readonly [
      path: P,
      options: Options<P> | undefined,
      config: MultipleQueryConfig<Data<P>>,
    ];

type EntryPath<E> = E extends readonly [infer P extends keyof GetRPC, ...any[]]
  ? P
  : never;

type EntryConfig<E> = E extends readonly [any, any, infer C] ? C : {};

/** `true`/`false` when the config pins `suspense`, `undefined` when it leaves it open. */
type SuspenseOf<C> = C extends { suspense: infer S }
  ? [S] extends [undefined]
    ? undefined
    : [S] extends [true]
      ? true
      : false
  : undefined;

type DefaultSuspense = GemiQueryDefaults extends { suspense: false }
  ? false
  : true;

type Suspends<C, G> =
  SuspenseOf<C> extends boolean
    ? SuspenseOf<C>
    : SuspenseOf<G> extends boolean
      ? SuspenseOf<G>
      : DefaultSuspense;

type EntryData<E, G> =
  Suspends<EntryConfig<E>, G> extends true
    ? NestedPrettify<Data<EntryPath<E>>>
    : NestedPrettify<Data<EntryPath<E>>> | undefined;

type Mutate<D> = {
  (value?: D): void;
  (updater?: (data: D) => D): void;
};

export interface MultipleQueryReturn<Q, G> {
  /** Each key's data, typed from its route. */
  data: { [K in keyof Q]: EntryData<Q[K], G> };
  /** True while at least one key is loading. */
  loading: boolean;
  /**
   * Each key's own loading flag, for a view that shows one key's spinner
   * apart from the others.
   */
  loadingByKey: { [K in keyof Q]: boolean };
  /** Each key's error, `null` when it has none. */
  error: { [K in keyof Q]: Record<string, unknown> | null };
  /** Each key's `mutate`, as `useQuery` returns it. */
  mutate: { [K in keyof Q]: Mutate<NestedPrettify<Data<EntryPath<Q[K]>>>> };
  /** Each key's `refetch`. */
  refetch: { [K in keyof Q]: () => void };
}

type ResolvedConfig = Config<any>;

interface Target {
  key: string;
  path: string;
  variantKey: string;
  suspense: boolean;
  resource: QueryResource;
}

type State = ReturnType<QueryResource["peek"]>;

/**
 * A key whose first answer is still on the wire: nothing to show for it yet.
 * A variant with no state at all counts: its request was started silently in
 * the render, or goes out in the mount effect.
 */
function awaitingFirstAnswer(target: Target) {
  const state = target.resource.peek(target.variantKey);
  return !state || (state.loading && !state.hasData);
}

/**
 * Several queries in one hook, with one render cycle for all of them.
 *
 * ```tsx
 * const { data, loading, error } = useMultipleQuery({
 *   products: ["/products"],
 *   category: ["/categories/:categoryId", { params: { categoryId } }],
 * });
 * data.products; // typed from GET /products
 * ```
 *
 * Each key is `[path, options?, config?]`, the arguments `useQuery` takes,
 * and reads the same cache: a key and a `useQuery` of the same path and
 * search share one request and one cached value.
 *
 * - Under suspense (the default) every key's request goes out in the same
 *   render and the component suspends once, until all of them answered.
 *   n `useQuery` calls suspend one after the other instead: a request
 *   waterfall and about two renders per query.
 * - With `suspense: false`, keys that are loading for the first time hold
 *   back the others' answers, so the component renders once with all of them.
 *   `loading` is true while at least one key is loading; `loadingByKey` has
 *   each key's own flag. Their requests start in the render too, so next to
 *   suspending keys (in this hook or another one) they go out in the same
 *   round instead of after the suspending ones answered.
 *
 * The optional second argument is config for every key; a key's own config
 * (the tuple's third element) wins over it.
 */
export function useMultipleQuery<
  const P extends { [K in keyof P]: keyof GetRPC },
  const Q extends { [K in keyof P]: readonly unknown[] },
  const G extends MultipleQueryConfig<any> = {},
>(
  queries: { [K in keyof P]: MultipleQueryEntry<P[K]> } & Q,
  config?: G,
): MultipleQueryReturn<Q, G>;
export function useMultipleQuery(
  queries: Record<string, MultipleQueryEntry>,
  sharedConfig?: MultipleQueryConfig<any>,
) {
  const { user: _user, ...appConfig } = useContext(QueryConfigContext) ?? {};
  const routeParams = useParams();
  const { getResource } = useContext(QueryManagerContext);
  const serverQueries = useContext(ServerQueryContext);
  const realtime = useContext(RealtimeContext);
  const { prefetchedData } = useRouteData();

  // Resolve every key against the route, like `useQuery` does for its one.
  const current = Object.keys(queries).map((key) => {
    const [url, options, callConfig] = queries[key] as readonly [
      string,
      Options<any>?,
      MultipleQueryConfig<any>?,
    ];
    const config: ResolvedConfig = {
      ...defaultConfig,
      ...mergeDefinedConfig<ResolvedConfig>(appConfig, sharedConfig, callConfig),
      lazy: false,
    };
    const target = resolveQueryTarget(
      url,
      { ...defaultOptions, ...options },
      routeParams,
    );
    return { key, url, config, suspense: config.suspense !== false, ...target };
  });

  // `keepPreviousData` under suspense, as in `useQuery`: a changed key reads
  // through the deferred targets, so the committed tree keeps the previous
  // data while React renders the new one in the background. One deferred
  // value for all keys: a string, since `queries` is a new object every
  // render. Only the keys that defer are in it: a deferred value that
  // changes always costs a second render, which the other keys don't need.
  const signature = JSON.stringify(
    current
      .filter((e) => e.suspense && e.config.keepPreviousData)
      .map((e) => [e.key, e.url, e.path, e.variantKey, e.params, e.search]),
  );
  const deferredSignature = useDeferredValue(signature);
  const deferred = useMemo(() => {
    const map = new Map<
      string,
      { url: string; path: string; variantKey: string; params: any; search: any }
    >();
    if (deferredSignature === signature) return map;
    for (const [key, url, path, variantKey, params, search] of JSON.parse(
      deferredSignature,
    )) {
      map.set(key, { url, path, variantKey, params, search });
    }
    return map;
  }, [deferredSignature, signature]);

  const entries = current.map((e) => {
    const previous =
      e.suspense && e.config.keepPreviousData ? deferred.get(e.key) : undefined;
    const visible = previous ?? e;
    const isDeferred =
      visible.path !== e.path || visible.variantKey !== e.variantKey;
    const seed =
      e.config.fallbackData != null
        ? { [visible.variantKey]: e.config.fallbackData }
        : prefetchedData?.[visible.path];
    return {
      ...e,
      url: visible.url,
      path: visible.path,
      variantKey: visible.variantKey,
      params: visible.params,
      search: visible.search,
      currentPath: e.path,
      currentVariantKey: e.variantKey,
      isDeferred,
      resource: getResource(visible.path, seed ?? undefined),
    };
  });

  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // What the subscription and the effects run on: stable while no key, path
  // or variant changes, whatever the call site re-creates each render.
  const targetsKey = entries
    .map((e) => `${e.key}\u0000${e.path}\u0000${e.variantKey}\u0000${e.suspense}`)
    .join("\n");
  const targets = useMemo<Target[]>(
    () =>
      entriesRef.current.map(({ key, path, variantKey, suspense, resource }) => ({
        key,
        path,
        variantKey,
        suspense,
        resource,
      })),
    // `getResource` is stable per provider; `targetsKey` captures the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetsKey, getResource],
  );

  // One subscription for every key. It retains each variant (so an
  // `invalidate` refetches it now), and batches: first answers that land
  // while another key still waits for its own are held back, then all of
  // them commit together. A change to data already on screen (a `mutate`, a
  // revalidation) is never held. Store writes in the same task coalesce into
  // one notification, checked after the writing request has finished.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const releases = targets.map((t) => t.resource.retain(t.variantKey));
      let notified = targets.map((t) => t.resource.peek(t.variantKey));
      let active = true;
      let scheduled = false;
      const flush = () => {
        scheduled = false;
        if (!active) return;
        const states = targets.map((t) => t.resource.peek(t.variantKey));
        const shownDataChanged = states.some(
          (state, i) => state !== notified[i] && notified[i]?.hasData,
        );
        if (!shownDataChanged && targets.some(awaitingFirstAnswer)) return;
        notified = states;
        onStoreChange();
      };
      const onChange = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
      };
      const unsubscribes = [...new Set(targets.map((t) => t.resource))].map(
        (resource) => resource.store.subscribe(onChange),
      );
      return () => {
        active = false;
        for (const unsubscribe of unsubscribes) unsubscribe();
        for (const release of releases) release();
      };
    },
    [targets],
  );
  // The states of all keys, as one value whose identity only changes when
  // one of them does (each `peek` is stable until a real write).
  const cacheRef = useRef<{ targets: Target[]; states: State[] } | null>(null);
  const getSnapshot = useCallback(() => {
    const states = targets.map((t) => t.resource.peek(t.variantKey));
    const cached = cacheRef.current;
    if (
      cached &&
      cached.targets === targets &&
      states.every((state, i) => state === cached.states[i])
    ) {
      return cached.states;
    }
    cacheRef.current = { targets, states };
    return states;
  }, [targets]);
  // Keys that don't suspend hydrate without streamed answers, as the server
  // rendered them (see `QueryResource.peekForHydration`).
  const serverCacheRef = useRef<{ targets: Target[]; states: State[] } | null>(
    null,
  );
  const getServerSnapshot = useCallback(() => {
    const states = targets.map((t) =>
      t.suspense
        ? t.resource.peek(t.variantKey)
        : t.resource.peekForHydration(t.variantKey),
    );
    const cached = serverCacheRef.current;
    if (
      cached &&
      cached.targets === targets &&
      states.every((state, i) => state === cached.states[i])
    ) {
      return cached.states;
    }
    serverCacheRef.current = { targets, states };
    return states;
  }, [targets]);
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // `keepPreviousData`: a key loading without data shows its last data. A
  // variant with no state yet counts as loading for a `suspense: false` key:
  // its request is on the wire (started silently in the render) or goes out
  // in the commit's effect. A suspending key suspends on it instead (#1255),
  // so a transition at the call site keeps the old tree committed.
  const lastDataRef = useRef(new Map<string, State>());
  useEffect(() => {
    snapshot.forEach((state, i) => {
      if (state?.hasData) lastDataRef.current.set(targets[i].key, state);
    });
  }, [snapshot, targets]);

  const states: State[] = entries.map((e, i) => {
    const state = snapshot[i];
    const last = lastDataRef.current.get(e.key);
    if (
      e.config.keepPreviousData &&
      !state?.hasData &&
      (state ? state.loading : !e.suspense) &&
      last
    ) {
      return { ...last, loading: true };
    }
    return state;
  });

  // The render-phase reads: every key without data starts (or joins) its
  // request now, before anything suspends, so the requests run in parallel
  // and the component suspends once for all of its suspense keys. A key with
  // `suspense: false` starts too (#1253), but is never waited for: on a cold
  // mount its request would otherwise wait for the commit's effect, after
  // every suspending read of the component had answered. A streaming server
  // render reads from the request's store instead, which streams a key's
  // answer into the client cache.
  const promises: Promise<void>[] = [];
  let thrown: { error: unknown } | null = null;
  entries.forEach((e, i) => {
    if (!e.suspense) {
      // The key's own state: `keepPreviousData` may show another variant's.
      if (snapshot[i]?.hasData || snapshot[i]?.error) return;
      if (typeof window === "undefined") {
        serverQueries?.ensure(e.url, { params: e.params, search: e.search });
      } else {
        e.resource.start(e.variantKey);
      }
      return;
    }
    const state = states[i];
    if (state?.hasData || state?.error) return;
    if (typeof window === "undefined") {
      const entry =
        serverQueries?.ensure(e.url, { params: e.params, search: e.search }) ??
        null;
      if (entry?.status === "resolved") {
        states[i] = {
          loading: false,
          data: entry.data,
          hasData: true,
          error: null,
          version: 0,
        };
        return;
      }
      if (entry?.status === "rejected") {
        thrown ??= { error: entry.error };
      } else if (entry) {
        promises.push(entry.promise);
      }
      if (!entry && process.env.NODE_ENV !== "production") {
        warnUnprefetched(e.url, e.variantKey, "useMultipleQuery");
      }
      return;
    }
    const { promise } = e.resource.read(e.variantKey, e.config.staleTime);
    if (promise) promises.push(promise);
  });

  // `live`: per key, as in `useQuery`. Keyed on the channels' values, since
  // an inline `live` object is a new one every render.
  const [liveOpen, setLiveOpen] = useState<Record<string, boolean>>({});
  const liveKey = JSON.stringify(
    entries.filter((e) => e.config.live).map((e) => [e.key, e.config.live]),
  );
  useEffect(() => {
    const channels: Array<[string, any]> = JSON.parse(liveKey);
    const stops = channels.map(([key, live]) => {
      // The key's resource now; the one it had when this ran, if it was
      // removed and this effect has not been cleaned up yet.
      const initial = entriesRef.current.find((e) => e.key === key)!.resource;
      return followLive(
        realtime,
        live,
        () =>
          entriesRef.current.find((e) => e.key === key)?.resource ?? initial,
        (open) =>
          setLiveOpen((prev) =>
            prev[key] === open ? prev : { ...prev, [key]: open },
          ),
      );
    });
    return () => {
      for (const stop of stops) stop();
    };
  }, [realtime, liveKey]);

  // A changed key still loading behind the previous data has no subscription
  // yet: hold its variant too, so changing it again aborts its request.
  const pendingKey = JSON.stringify(
    entries
      .filter((e) => e.isDeferred)
      .map((e) => [e.key, e.currentPath, e.currentVariantKey]),
  );
  useEffect(() => {
    const releases = (
      JSON.parse(pendingKey) as Array<[string, string, string]>
    ).map(([key, path, variantKey]) => {
      const config = entriesRef.current.find((e) => e.key === key)?.config;
      const seed =
        config?.fallbackData != null
          ? { [variantKey]: config.fallbackData }
          : prefetchedData?.[path];
      return getResource(path, seed ?? undefined).retain(variantKey);
    });
    return () => {
      for (const release of releases) release();
    };
  }, [pendingKey, getResource, prefetchedData]);

  // Mount / variant-change revalidation.
  useEffect(() => {
    for (const t of targets) {
      const config = entriesRef.current.find((e) => e.key === t.key)?.config;
      t.resource.getVariant(t.variantKey, config?.staleTime);
    }
  }, [targets]);

  const configOf = (key: string): ResolvedConfig =>
    entriesRef.current.find((e) => e.key === key)?.config ?? defaultConfig;

  // Background retries for failed `suspense: false` keys, once per new state.
  const retriedRef = useRef(new Map<string, State>());
  useEffect(() => {
    targets.forEach((t, i) => {
      const state = snapshot[i];
      if (retriedRef.current.get(t.key) === state) return;
      retriedRef.current.set(t.key, state);
      const config = configOf(t.key);
      if (config.suspense !== false) return;
      retryFailedQuery(t.resource, t.variantKey, state, config);
    });
  });

  useEffect(() => {
    const cleanups = targets.map((t) =>
      retryWhenOnline(t.resource, t.variantKey, () => configOf(t.key)),
    );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets]);

  // `refetchUntil`, per key, after every commit.
  const pollsRef = useRef(new Map<string, PollState>());
  useEffect(() => {
    const polls = pollsRef.current;
    const keys = new Set(targets.map((t) => t.key));
    for (const [key, poll] of polls) {
      if (!keys.has(key)) {
        stopPoll(poll);
        polls.delete(key);
      }
    }
    targets.forEach((t, i) => {
      let poll = polls.get(t.key);
      if (!poll) {
        poll = createPollState();
        polls.set(t.key, poll);
      }
      stepPoll(
        poll,
        t.resource,
        t.variantKey,
        snapshot[i],
        configOf(t.key).refetchUntil,
        !!liveOpen[t.key],
      );
    });
  });
  useEffect(
    () => () => {
      for (const poll of pollsRef.current.values()) stopPoll(poll);
    },
    [],
  );

  const intervalsKey = JSON.stringify(
    entries.map((e) => (liveOpen[e.key] ? null : e.config.refreshInterval)),
  );
  useEffect(() => {
    const intervals: number[] = JSON.parse(intervalsKey);
    const timers = targets.map((t, i) =>
      intervals[i] == null
        ? null
        : setInterval(
            () => reloadQuery(t.resource, t.variantKey, configOf(t.key)),
            intervals[i],
          ),
    );
    return () => {
      for (const timer of timers) if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, intervalsKey]);

  const focusRef = useRef(new Map<string, FocusState>());
  const focusKey = entries.map((e) => (e.config.revalidateOnFocus ? 1 : 0)).join();
  useEffect(() => {
    const flags = focusKey.split(",");
    const cleanups = targets.map((t, i) => {
      if (flags[i] !== "1") return null;
      let focus = focusRef.current.get(t.key);
      if (!focus) {
        focus = { eligible: true, wasAway: false, last: 0 };
        focusRef.current.set(t.key, focus);
      }
      return revalidateOnFocus(t.resource, t.variantKey, focus, () =>
        configOf(t.key),
      );
    });
    return () => {
      for (const cleanup of cleanups) cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, focusKey]);

  useEffect(
    () =>
      onHttpReload(() => {
        for (const t of targets) {
          reloadQuery(t.resource, t.variantKey, configOf(t.key));
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets],
  );

  // Suspend last, after every hook has run (see `useQuery`). Any key's error
  // goes to the error boundary; otherwise the component waits for every
  // pending key at once.
  if (thrown) throw (thrown as { error: unknown }).error;
  entries.forEach((e, i) => {
    const state = states[i];
    if (e.suspense && state?.error && !state?.hasData) throw state.error;
  });
  if (promises.length > 0) {
    throw promises.length === 1 ? promises[0] : Promise.all(promises);
  }

  const data: Record<string, unknown> = {};
  const error: Record<string, unknown> = {};
  const mutate: Record<string, (fn?: unknown) => void> = {};
  const refetch: Record<string, () => void> = {};
  const loadingByKey: Record<string, boolean> = {};
  let loading = false;
  entries.forEach((e, i) => {
    const state = states[i];
    data[e.key] = state?.data;
    error[e.key] = state?.error ?? null;
    loadingByKey[e.key] = e.isDeferred || (state?.loading ?? true);
    if (loadingByKey[e.key]) loading = true;
    // Bound to the visible variant, like `useQuery`'s callbacks.
    mutate[e.key] = (fn) => {
      mutateQuery(e.resource, e.variantKey, fn);
    };
    refetch[e.key] = () => e.resource.refetch(e.variantKey);
  });

  return { data, loading, loadingByKey, error, mutate, refetch };
}
