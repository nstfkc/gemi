import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { QueryResource } from "./QueryResource";

export type PrefetchedData = Record<string, Record<string, any>>;

export interface QueryManagerContextValue {
  getResource: (
    key: string,
    initialState?: Record<string, any>,
  ) => QueryResource;
  hydrate: (prefetchedData?: PrefetchedData | null) => void;
}

export const QueryManagerContext = createContext<QueryManagerContextValue>({
  getResource: (key: string, initialState: Record<string, any> = {}) => {
    return new QueryResource(key, initialState);
  },
  hydrate: () => {},
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

  const value = useMemo(
    () => ({ getResource, hydrate }),
    [getResource, hydrate],
  );

  return (
    <QueryManagerContext.Provider value={value}>
      {children}
    </QueryManagerContext.Provider>
  );
};
