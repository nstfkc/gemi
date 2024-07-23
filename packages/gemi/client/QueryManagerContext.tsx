import { createContext, useEffect, useState } from "react";
import { QueryManager } from "./QueryManager";

export const QueryManagerContext = createContext<{ manager: QueryManager }>(
  {} as any,
);

export const QueryManagerProvider = ({ children }) => {
  const [manager] = useState(() => new QueryManager());

  useEffect(() => {
    if (typeof window !== undefined) {
      (window as any).qm = manager;
    }
  }, [manager]);

  return (
    <QueryManagerContext.Provider value={{ manager }}>
      {children}
    </QueryManagerContext.Provider>
  );
};
