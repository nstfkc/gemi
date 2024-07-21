import { createContext, useState } from "react";
import { QueryManager } from "./QueryManager";

export const QueryManagerContext = createContext<{ manager: QueryManager }>(
  null,
);

export const QueryManagerProvider = ({ children }) => {
  const [manager] = useState(() => new QueryManager());
  return (
    <QueryManagerContext.Provider value={{ manager }}>
      {children}
    </QueryManagerContext.Provider>
  );
};
