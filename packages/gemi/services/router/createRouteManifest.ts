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
        if (routeManifest[routePath].length === 1) {
          // If the layout doesn't have any children, remove it from the manifest
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
