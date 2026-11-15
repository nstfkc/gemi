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

/**
 * Whether `pathname`, as it stands, names a `this.file(...)` route. A file
 * route declared at `/.well-known/x.json` or `/doc.og` is that file, not a
 * view's data or og URL (#1275).
 */
function namesFileRoute(flatViewRoutes: FlatViewRoutes, pathname: string): boolean {
  return matchViewRoute(flatViewRoutes, pathname)?.route.segments.at(-1)?.viewPath === "FILE";
}

/**
 * Whether a view request for `pathname` asks for a view's data (the client
 * router's `.json` navigation payload) rather than the path itself. Only a
 * `.json` path is matched against the routes.
 */
export function isViewDataPath(flatViewRoutes: FlatViewRoutes, pathname: string): boolean {
  return pathname.endsWith(".json") && !namesFileRoute(flatViewRoutes, pathname);
}

/** Whether a view request for `pathname` asks for a view's og image. */
export function isViewOgPath(flatViewRoutes: FlatViewRoutes, pathname: string): boolean {
  return pathname.endsWith(".og") && !namesFileRoute(flatViewRoutes, pathname);
}
