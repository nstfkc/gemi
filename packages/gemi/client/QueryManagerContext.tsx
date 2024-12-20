import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useRef,
} from "react";
import { QueryResource } from "./QueryResource";
import { ServerDataContext } from "./ServerDataProvider";
import { HttpClientContext } from "./HttpClientContext";

export const QueryManagerContext = createContext({
  getResource: (key: string, initialState: Record<string, any> = {}) => {
    return new QueryResource(key, initialState, fetch, "");
  },
  updatePrefecthedData: (_data: Record<string, Record<string, any>>) => {},
});

export const QueryManagerProvider = ({ children }: PropsWithChildren) => {
  const resourcesRef = useRef<Map<string, QueryResource>>(new Map());
  const { prefetchedData } = useContext(ServerDataContext);
  const prefetchedDataRef = useRef(prefetchedData);
  const { fetch, host } = useContext(HttpClientContext);

  const updatePrefecthedData = (data: Record<string, Record<string, any>>) => {
    for (const [key, value] of Object.entries(data)) {
      prefetchedDataRef.current[key] = value;
    }
  };

  useEffect(() => {
    (window as any).qr = resourcesRef.current;
  }, []);

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
              new QueryResource(key, _initialState ?? {}, fetch, host),
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
