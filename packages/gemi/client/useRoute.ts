import { useContext } from "react";
import type { ViewPaths } from "./types";
import { RouteStateContext } from "./RouteStateContext";

type Pathname = ViewPaths;

/**
 * The matched route: its template (`/users/:userId/ai`), the same on a direct
 * load and after a client navigation. `useLocation().pathname` is the resolved
 * URL. A `404` matched no route, so it reports the path that was requested.
 */
export function useRoute() {
  const { routePath, pathname } = useContext(RouteStateContext);
  const _pathname = routePath || pathname;
  return {
    pathname: _pathname,
    startsWith: (pathname: Pathname) => {
      return _pathname.startsWith(pathname);
    },
  };
}
