import {
  createContext,
  type PropsWithChildren,
  useContext,
  useMemo,
  useRef,
} from "react";
import { QueryResource } from "./QueryResource";

export const QueryManagerContext = createContext({
  getResource: (key: string, initialState: Record<string, any> = {}) => {
    return new QueryResource(key, initialState);
  },
});

export const QueryManagerProvider = ({ children }: PropsWithChildren<{}>) => {
  const resourcesRef = useRef<Map<string, QueryResource>>(new Map());

  const value = useMemo(
    () => ({
      getResource: (key: string, initialState?: Record<string, any>) => {
        if (!resourcesRef.current.has(key)) {
          resourcesRef.current.set(
            key,
            new QueryResource(key, initialState ?? {}),
          );
        }
        return resourcesRef.current.get(key);
      },
    }),
    [],
  );

  return (
    <QueryManagerContext.Provider value={value}>
      {children}
    </QueryManagerContext.Provider>
  );
};
