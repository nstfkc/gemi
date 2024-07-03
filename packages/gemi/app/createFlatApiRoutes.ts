import { Middleware } from "../http";
import { ApiRouteChildren, ApiRouteExec } from "../http/ApiRouter";
import { RouterMiddleware } from "../http/Router";

export function createFlatApiRoutes(routes: ApiRouteChildren) {
  const flatApiRoutes: Record<
    string,
    Record<
      string,
      {
        exec: ApiRouteExec;
        middleware: (string | (new () => Middleware) | RouterMiddleware)[];
      }
    >
  > = {};
  for (const [rootPath, apiConfigOrApiRouter] of Object.entries(routes)) {
    if ("prepare" in apiConfigOrApiRouter) {
      if (!flatApiRoutes[rootPath]) {
        flatApiRoutes[rootPath] = {};
      }
      const { exec, method, middleware } = apiConfigOrApiRouter.prepare();
      flatApiRoutes[rootPath][method] = {
        exec,
        middleware: [...middleware],
      };
    } else if (Array.isArray(apiConfigOrApiRouter)) {
      for (const apiConfig of apiConfigOrApiRouter) {
        if (!flatApiRoutes[rootPath]) {
          flatApiRoutes[rootPath] = {};
        }
        const { exec, method, middleware } = apiConfig.prepare();
        flatApiRoutes[rootPath][method] = {
          exec,
          middleware,
        };
      }
    } else {
      const router = new apiConfigOrApiRouter();

      const result = createFlatApiRoutes(router.routes);
      for (const [path, handlers] of Object.entries(result)) {
        const subPath = path === "/" ? "" : path;
        const _rootPath = rootPath === "/" ? "" : rootPath;
        const finalPath =
          `${_rootPath}${subPath}` === "" ? "/" : `${_rootPath}${subPath}`;
        if (!flatApiRoutes[finalPath]) {
          flatApiRoutes[finalPath] = {};
        }
        for (const [method, handler] of Object.entries(handlers)) {
          flatApiRoutes[finalPath][method] = {
            exec: handler.exec,
            middleware: [
              router.middleware,
              ...router.middlewares,
              ...handler.middleware,
            ],
          };
        }
      }
    }
  }

  return flatApiRoutes;
}
