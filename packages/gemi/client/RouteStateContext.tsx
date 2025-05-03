import type { Action } from "history";
import { createContext, type PropsWithChildren } from "react";

export interface RouteState {
  views: string[];
  params: Record<string, string>;
  search: string;
  state: Record<string, unknown>;
  pathname: string;
  hash: string;
  action: Action | null;
  routePath: string;
  locale: string | null;
}

export type PageData = {
  data: Record<string, unknown>;
  i18n: {
    currentLocale: string;
    dictionary: Record<string, Record<string, unknown>>;
    supportedLocales: string[];
  };
  prefetchedData: Record<string, unknown>;
  breadcrumbs: any;
};

export const RouteStateContext = createContext({} as RouteState & PageData);

export const RouteStateProvider = (
  props: PropsWithChildren<{
    state: RouteState & PageData;
  }>,
) => {
  return (
    <RouteStateContext.Provider value={props.state}>
      {props.children}
    </RouteStateContext.Provider>
  );
};
