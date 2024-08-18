import { useContext } from "react";
import { useLocation, ClientRouterContext } from "./ClientRouterContext";
import type { ViewPaths } from "./types";

type Pathname = ViewPaths;

export function usePathname(): Pathname {
  const { getRoutePathnameFromHref } = useContext(ClientRouterContext);
  const location = useLocation();

  return getRoutePathnameFromHref(location.pathname) as Pathname;
}
