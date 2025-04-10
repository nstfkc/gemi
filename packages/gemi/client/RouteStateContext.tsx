import { createContext, type PropsWithChildren } from "react"

export interface RouteState {
  search: string;
  pathname: string;
  params: Record<string, string>
}

export const RouteStateContext = createContext({} as RouteState)

export const RouteStateProvider = (props: PropsWithChildren<{ state: RouteState }>) => {
  return <RouteStateContext.Provider value={props.state}>{props.children}</RouteStateContext.Provider>
}
