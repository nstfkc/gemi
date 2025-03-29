import {
  createContext,
  type PropsWithChildren,
  useContext,
  useRef,
} from "react";
import { QueryResource } from "./QueryResource";
import { HttpClientContext } from "./HttpClientContext";

export const QueryManagerContext = createContext({
  getResource: (key: string, initialState: Record<string, any> = {}) => {
    return new QueryResource(key, initialState, fetch, "");
  },
  updatePrefecthedData: (_data: Record<string, Record<string, any>>) => {},
});

export const QueryManagerProvider = ({
  children,
  prefetchedData = {},
}: PropsWithChildren<{
  prefetchedData: Record<string, Record<string, any>>;
}>) => {
  const resourcesRef = useRef<Map<string, QueryResource>>(new Map());
  const prefetchedDataRef = useRef(prefetchedData);
  const { fetch, host } = useContext(HttpClientContext);

  const updatePrefecthedData = (data: Record<string, Record<string, any>>) => {
    for (const [key, value] of Object.entries(data)) {
      prefetchedDataRef.current[key] = value;
    }
  };

  return (
    <QueryManagerContext.Provider
      value={{
        updatePrefecthedData,
        getResource: (key: string, initialState?: Record<string, any>) => {
          let _initialState = initialState;
          if (!_initialState && prefetchedDataRef.current[key]) {
            _initialState = prefetchedDataRef.current[key];
          }
          if (!resourcesRef.current.has(key)) {
            resourcesRef.current.set(
              key,
              new QueryResource(key, _initialState ?? {}, fetch as any, host),
            );
          }
          return resourcesRef.current.get(key);
        },
      }}
    >
      {children}
    </QueryManagerContext.Provider>
  );
};
