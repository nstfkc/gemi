import { ViewChildren } from "../http/ViewRouter";

export function createRouteManifest(routes: ViewChildren) {
  const routeManifest: Record<string, string[]> = {};
  for (const [routePath, routeHandler] of Object.entries(routes)) {
    if ("prepare" in routeHandler) {
      const { viewPath, children, kind } = routeHandler.prepare();

      if (kind === "view") {
        routeManifest[routePath] = [viewPath];
      }

      if (Object.entries(children).length > 0) {
        const manifest = createRouteManifest(children);
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
