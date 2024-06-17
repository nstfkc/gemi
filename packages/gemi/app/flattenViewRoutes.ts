import type { ComponentTree } from "../client/types";
import {
  ViewRouter,
  type ViewChildren,
  type ViewRouteExec,
} from "../http/ViewRouter";
import type { App } from "./App";

export function flattenViewRoutes(routes: ViewChildren, app: App) {
  const flatRoutes: Record<
    string,
    { exec: ViewRouteExec[]; middleware: any[] }
  > = {};
  const routeManifest: Record<string, string[]> = {};
  const componentTree: ComponentTree = [];

  for (const [rootPath, viewConfigOrViewRouter] of Object.entries(routes)) {
    let children;
    let rootHandler: ViewRouteExec = async () => ({});
    let rootMiddleware: any[] = [];
    let layoutViewPath: string | null = null;
    if ("prepare" in viewConfigOrViewRouter) {
      const result = viewConfigOrViewRouter.prepare();
      children = result.children;
      rootHandler = result.exec;
      flatRoutes[rootPath] = {
        exec: [rootHandler],
        middleware: result.middlewares,
      };
      if (Object.keys(children).length > 0) {
        layoutViewPath = result.viewPath;
      } else {
        routeManifest[rootPath] = [result.viewPath];
        componentTree.push([result.viewPath]);
      }
    } else {
      const router = new viewConfigOrViewRouter(app);
      const middlewares = router.middlewares
        .map((alias) => {
          if (app.middlewareAliases?.[alias]) {
            const middleware = new app.middlewareAliases[alias]();
            return middleware.run;
          }
        })
        .filter(Boolean);

      rootMiddleware.push(router.middleware, ...middlewares);
      children = router.routes;
    }

    const result = flattenViewRoutes(children, app);

    if (layoutViewPath) {
      componentTree.push({ [layoutViewPath]: result.componentTree });
    } else {
      componentTree.push(...result.componentTree);
    }

    for (const [path, handlers] of Object.entries(result.flatRoutes)) {
      const subPath = path === "/" ? "" : path;
      const _rootPath = rootPath === "/" ? "" : rootPath;
      const finalPath =
        `${_rootPath}${subPath}` === "" ? "/" : `${_rootPath}${subPath}`;
      flatRoutes[finalPath] = {
        exec: [rootHandler, ...handlers.exec],
        middleware: [...rootMiddleware, ...handlers.middleware],
      };
      if (layoutViewPath) {
        routeManifest[finalPath] = [
          layoutViewPath,
          ...(result.routeManifest[path] ?? []),
        ];
      } else {
        routeManifest[finalPath] = [...(result.routeManifest[path] ?? [])];
      }
    }
  }

  return {
    flatRoutes,
    routeManifest,
    componentTree,
  };
}
