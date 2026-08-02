import type { ViewRoutes } from "../../http/ViewRouter";
function removeGroupPrefix(input: string) {
  // Remove all (str) patterns
  const withoutParentheses = input.replace(/\([^)]*\)/g, "");

  // Remove all double slashes // by replacing with single slash
  const withoutDoubleSlashes = withoutParentheses.replace(/\/\//g, "/");
  return withoutDoubleSlashes;
}

export function createRouteManifest(routes: ViewRoutes) {
  const routeManifest: Record<string, string[]> = {};
  for (const [routePath, routeHandler] of Object.entries(routes)) {
    if ("run" in routeHandler) {
      // `viewPath` is "FILE" for file routes and "REDIRECT" for redirect routes,
      // neither of which resolves to a component — consumers filter them out.
      const viewPath = routeHandler.viewPath;

      if ("children" in routeHandler) {
        // Add the layout view
        routeManifest[routePath] = [viewPath];
        const children = new routeHandler.children();
        const manifest = createRouteManifest(children.routes);
        for (const [path, viewPaths] of Object.entries(manifest)) {
          const key = routePath === "/" ? path : `${routePath}${path}`;
          const _key = path === "/" && routePath !== "/" ? routePath : key;
          routeManifest[_key] = [viewPath, ...viewPaths];
        }
        // **A layout with no index route is not a navigable path.**
        //
        // Still length 1 means nothing merged into this key — the layout has no
        // `"/"` child — so the path would resolve to layouts and no page, and
        // rendering it would produce a blank content area. `createFlatViewRoutes`
        // agrees: `/foo` and `/foo/bar` appear there only as *segments* of
        // `/foo/bar/baz`, never as matchable routes of their own.
        //
        // The condition is "no index route", which is broader than the "no
        // children at all" this comment used to claim — a layout whose only
        // children are deeper layouts is removed too, and that is the case the
        // stale test in this directory expected to survive.
        if (routeManifest[routePath].length === 1) {
          delete routeManifest[routePath];
        }
      } else {
        routeManifest[routePath] = [viewPath];
      }
    } else {
      const router = new routeHandler();

      const manifest = createRouteManifest(router.routes);
      for (const [path, viewPaths] of Object.entries(manifest)) {
        const key = routePath === "/" ? path : `${routePath}${path}`;
        const _key = path === "/" && routePath !== "/" ? routePath : key;
        routeManifest[_key] = viewPaths;
      }
    }
  }

  return Object.fromEntries(
    Object.entries(routeManifest).map(([key, value]) => [
      removeGroupPrefix(key),
      value,
    ]),
  );
}
