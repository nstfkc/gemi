import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { QueryResource } from "./QueryResource";

/** One streamed query payload: `[path, variantKey, data]`. */
type StreamedQueryPayload = [string, string, any];

export type PrefetchedData = Record<string, Record<string, any>>;

export interface QueryManagerContextValue {
  getResource: (
    key: string,
    initialState?: Record<string, any>,
  ) => QueryResource;
  hydrate: (prefetchedData?: PrefetchedData | null) => void;
  clearErrors: () => void;
}

export const QueryManagerContext = createContext<QueryManagerContextValue>({
  getResource: (key: string, initialState: Record<string, any> = {}) => {
    return new QueryResource(key, initialState);
  },
  hydrate: () => {},
  clearErrors: () => {},
});

export const QueryManagerProvider = ({ children }: PropsWithChildren<{}>) => {
  const resourcesRef = useRef<Map<string, QueryResource>>(new Map());

  const getResource = useCallback(
    (key: string, initialState?: Record<string, any>) => {
      let resource = resourcesRef.current.get(key);
      if (!resource) {
        resource = new QueryResource(key, initialState ?? {});
        resourcesRef.current.set(key, resource);
      }
      return resource;
    },
    [],
  );

  // Resources are cached by path for the lifetime of the app, so `initialState`
  // above only ever applies to the first load. Every navigation ships a fresh
  // `prefetchedData` payload that has to be pushed into the existing resources,
  // otherwise the components mounting on the new surface refetch it over `/api`.
  const hydrate = useCallback((prefetchedData?: PrefetchedData | null) => {
    if (!prefetchedData) return;
    for (const [key, initialState] of Object.entries(prefetchedData)) {
      if (!initialState || typeof initialState !== "object") continue;
      const resource = resourcesRef.current.get(key);
      if (resource) {
        resource.hydrate(initialState);
      } else {
        resourcesRef.current.set(key, new QueryResource(key, initialState));
      }
    }
  }, []);

  // Used by the route-level error boundary's reset: without this, the retried
  // render would read the stored failure back out of the cache and re-throw.
  const clearErrors = useCallback(() => {
    for (const resource of resourcesRef.current.values()) {
      resource.clearError();
    }
  }, []);

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
      hydrate({ [path]: { [variantKey]: data } });
    };
    const buffered = Array.isArray(w.__GEMI_STREAM__) ? w.__GEMI_STREAM__ : [];
    w.__GEMI_STREAM__ = { push: adopt };
    for (const payload of buffered) {
      adopt(payload);
    }
  }

  const value = useMemo(
    () => ({ getResource, hydrate, clearErrors }),
    [getResource, hydrate, clearErrors],
  );

  return (
    <QueryManagerContext.Provider value={value}>
      {children}
    </QueryManagerContext.Provider>
  );
};
