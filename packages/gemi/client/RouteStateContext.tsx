import type { Action } from "history";
import { createContext, type PropsWithChildren } from "react";

export interface RouteState {
  views: string[];
  params: Record<string, string>;
  search: string;
  state: Record<string, unknown>;
  /** The resolved URL path, without its locale segment: `/users/7/ai`. */
  pathname: string;
  hash: string;
  action: Action | null;
  /**
   * The history entry the route is on (`scrollRestoration.entryKey`): new on
   * every navigation, including to the same URL. Absent on the server.
   */
  key?: string;
  /**
   * The matched route's template: `/users/:userId/ai`. Empty when no route
   * matched (a `404`).
   */
  routePath: string;
  locale: string | null;
}

export type PageData = {
  data: Record<string, unknown>;
  i18n: {
    currentLocale: string;
    dictionary: Record<string, Record<string, unknown>>;
    supportedLocales: string[];
    defaultLocale?: string;
    /** The IANA zone dates are formatted in, resolved on the server. */
    timeZone?: string;
  };
  prefetchedData: Record<string, unknown>;
  breadcrumbs: any;
  appId: string;
  /**
   * Evaluated features, replaced on every navigation.
   *
   * Lives here rather than only on `ServerDataContext` for the same reason
   * `i18n` does: the server re-evaluates on each navigation payload, so reading
   * from route state is what makes switching a feature on land without a hard
   * reload.
   */
  features: Record<string, boolean>;
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
