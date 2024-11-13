import { useContext } from "react";
import { useLocation, ClientRouterContext } from "./ClientRouterContext";
import type { ViewPaths } from "./types";

type Pathname = ViewPaths;

export function useRoute() {
  const { getRoutePathnameFromHref } = useContext(ClientRouterContext);
  const location = useLocation();
  const routePath = getRoutePathnameFromHref(location.pathname) as Pathname;
  return {
    pathname: routePath,
    startsWith: (pathname: Pathname) => {
      return (routePath as string).startsWith(pathname);
    },
  };
}
