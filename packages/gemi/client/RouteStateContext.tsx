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
  appId: string;
  /**
   * Evaluated feature flags, replaced on every navigation.
   *
   * Lives here rather than only on `ServerDataContext` for the same reason
   * `i18n` does: the server re-evaluates on each navigation payload, so reading
   * from route state is what makes a flag change land without a hard reload.
   */
  features: Record<string, boolean | string | number | null>;
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
