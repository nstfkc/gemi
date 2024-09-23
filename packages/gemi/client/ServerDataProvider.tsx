import { createContext, type PropsWithChildren } from "react";
import type { Translations } from "./i18n/I18nContext";
import type { ComponentTree } from "./types";
import type { User } from "../auth/adapters/types";

type Data = Record<string, any>;

export interface ServerDataContextValue {
  routeManifest: Record<string, string[]>;
  pageData: Record<string, Record<string, Data>>;
  prefetchedData: Record<string, Data>;
  router: {
    pathname: string;
    params: Record<string, any>;
    currentPath: string;
    is404: boolean;
    searchParams: string;
  };
  i18n: {
    dictionary: Translations;
    currentLocale: string;
    supportedLocales: string[];
  };
  componentTree: ComponentTree;
  auth: {
    user: User;
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
