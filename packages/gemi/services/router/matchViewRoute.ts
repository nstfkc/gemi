// @ts-ignore
import { URLPattern } from "urlpattern-polyfill/urlpattern";
import type { FlatViewRoutes } from "./createFlatViewRoutes";

export interface ViewRouteMatch {
  routePath: string;
  params: Record<string, string>;
  route: FlatViewRoutes[string];
}

/**
 * First route whose pattern matches `pathname`. `flatViewRoutes` is ordered
 * least-specific-first, so this is insertion order, not a best match.
 */
export function matchViewRoute(
  flatViewRoutes: FlatViewRoutes,
  pathname: string,
): ViewRouteMatch | null {
  for (const [routePath, route] of Object.entries(flatViewRoutes)) {
    const pattern = new URLPattern({ pathname: routePath });
    if (pattern.test({ pathname })) {
      return {
        routePath,
        params: pattern.exec({ pathname })?.pathname.groups ?? {},
        route,
      };
    }
  }

  return null;
}
