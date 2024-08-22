import { createContext, useRef } from "react";
import { QueryResource } from "./QueryResource";

export const QueryManagerContext = createContext({
  getResource: (key: string, initialState: Record<string, any> = {}) => {
    return new QueryResource(key, initialState);
  },
});

export const QueryManagerProvider = ({ children }) => {
  const resourcesRef = useRef<Map<string, QueryResource>>(new Map());

  return (
    <QueryManagerContext.Provider
      value={{
        getResource: (key: string, initialState: Record<string, any> = {}) => {
          if (!resourcesRef.current.has(key)) {
            resourcesRef.current.set(key, new QueryResource(key, initialState));
          }
          return resourcesRef.current.get(key);
        },
      }}
    >
      {children}
    </QueryManagerContext.Provider>
  );
};
