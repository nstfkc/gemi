import { createContext, type PropsWithChildren } from "react";
import type { Translations } from "./I18nContext";
import type { ComponentTree } from "./types";
import type { User } from "../auth/types";

type Data = Record<string, any>;

export interface ServerDataContextValue {
  routeManifest: Record<string, string[]>;
  pageData: Record<string, Record<string, Data>>;
  breadcrumbs: Record<string, { label: string; href: string }>;
  prefetchedData: Record<string, Data>;
  router: {
    pathname: string;
    params: Record<string, any>;
    currentPath: string;
    is404: boolean;
    searchParams: string;
    urlLocaleSegment: string | null;
  };
  i18n: {
    dictionary: Translations;
    currentLocale: string;
    supportedLocales: string[];
    defaultLocale: string;
  };
  componentTree: ComponentTree;
  auth: {
    user: User;
  };
  /**
   * Evaluated features for this request: `key -> boolean`, nothing else.
   *
   * Never the targeting or the reason a feature resolved the way it did — those
   * stay on the server. Read through `useFeature` rather than directly.
   */
  features: Record<string, boolean>;
  __csrf: string;
  cssManifest: Record<string, string[]>;
  /** Built chunk URLs per view name, for warming a navigation's imports. */
  modulePreloadManifest: Record<string, string[]>;
  meta: any;
  appId: string;
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
