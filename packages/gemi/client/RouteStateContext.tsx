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

export const RouteStateContext = createContext({} as RouteState);

export const RouteStateProvider = (
  props: PropsWithChildren<{ state: RouteState }>,
) => {
  return (
    <RouteStateContext.Provider value={props.state}>
      {props.children}
    </RouteStateContext.Provider>
  );
};
