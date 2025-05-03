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
});

export const QueryManagerProvider = ({ children }: PropsWithChildren<{}>) => {
  const resourcesRef = useRef<Map<string, QueryResource>>(new Map());
  const { fetch, host } = useContext(HttpClientContext);

  return (
    <QueryManagerContext.Provider
      value={{
        getResource: (key: string, initialState?: Record<string, any>) => {
          if (!resourcesRef.current.has(key)) {
            resourcesRef.current.set(
              key,
              new QueryResource(key, initialState ?? {}, fetch as any, host),
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
