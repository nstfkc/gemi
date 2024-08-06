import { createContext, type PropsWithChildren } from "react";
import type { ComponentTree } from "./types";

type Data = Record<string, any>;

export interface ServerDataContextValue {
  routeManifest: Record<string, string[]>;
  pageData: Record<string, Record<string, Data>>;
  router: {
    pathname: string;
    params: Record<string, any>;
    currentPath: string;
    is404: boolean;
    searchParams: string;
  };
  componentTree: ComponentTree;
  auth: {
    user: {
      name: string;
      email: string;
      accounts: Array<{
        organizationId: string;
        role: string;
      }>;
      globalRole: string;
      id: string;
    };
  };
}

export const ServerDataContext = createContext({} as ServerDataContextValue);

interface ServerDataProviderProps {
  value?: ServerDataContextValue;
}

export const ServerDataProvider = (
  props: PropsWithChildren<ServerDataProviderProps>,
) => {
  let _value = props.value;
  // Server
  if (props.value) {
    _value = props.value;
  } else {
    // Client
    _value = (window as any).__GEMI_DATA__;
  }

  return (
    <ServerDataContext.Provider value={_value}>
      {props.children}
    </ServerDataContext.Provider>
  );
};
