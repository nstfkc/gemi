import { useContext } from "react";
import type { ViewPaths } from "./types";
import { RouteStateContext } from "./RouteStateContext";

type Pathname = ViewPaths;

export function useRoute() {
  const { pathname: _pathname } = useContext(RouteStateContext);
  return {
    pathname: _pathname,
    startsWith: (pathname: Pathname) => {
      return _pathname.startsWith(pathname);
    },
  };
}
