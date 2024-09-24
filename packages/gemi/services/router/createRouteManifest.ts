import { ViewRoutes } from "../http/ViewRouter";

export function createRouteManifest(routes: ViewRoutes) {
  const routeManifest: Record<string, string[]> = {};
  for (const [routePath, routeHandler] of Object.entries(routes)) {
    if ("run" in routeHandler) {
      const viewPath = routeHandler.viewPath;

      if ("children" in routeHandler) {
        routeManifest[routePath] = [viewPath];
      }

      if ("children" in routeHandler) {
        const children = new routeHandler.children();
        const manifest = createRouteManifest(children.routes);
        for (const [path, viewPaths] of Object.entries(manifest)) {
          const key = routePath === "/" ? path : `${routePath}${path}`;
          const _key = path === "/" && routePath !== "/" ? routePath : key;
          routeManifest[_key] = [viewPath, ...viewPaths];
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

  return routeManifest;
}
