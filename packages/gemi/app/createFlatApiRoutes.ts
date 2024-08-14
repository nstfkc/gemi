import { Middleware } from "../http";
import {
  ApiRoutes,
  RouteHandlers,
  FileHandler,
  ApiRouter,
} from "../http/ApiRouter";
import { RouterMiddleware } from "../http/Router";
import { isConstructor } from "../internal/isConstructor";

type ApiRouteExec = any;

function isRouter(
  routeHandlers: RouteHandlers | FileHandler | (new () => ApiRouter),
): routeHandlers is new () => ApiRouter {
  return isConstructor(routeHandlers);
}

export function createFlatApiRoutes(routes: ApiRoutes) {
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
  for (const [rootPath, apiRouteHandlerOrApiRouter] of Object.entries(routes)) {
    if ("run" in apiRouteHandlerOrApiRouter) {
      const routeHandler = apiRouteHandlerOrApiRouter;
      if (!flatApiRoutes[rootPath]) {
        flatApiRoutes[rootPath] = {};
      }
      const method = routeHandler.method;
      const middleware = routeHandler.middlewares;
      const exec = routeHandler.run.bind(routeHandler);
      flatApiRoutes[rootPath][method] = {
        exec,
        middleware: [...middleware, ...routeHandler.middlewares],
      };
    } else if (isRouter(apiRouteHandlerOrApiRouter)) {
      const router = new apiRouteHandlerOrApiRouter();

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
    } else {
      for (const routeHandler of Object.values(apiRouteHandlerOrApiRouter)) {
        if (!flatApiRoutes[rootPath]) {
          flatApiRoutes[rootPath] = {};
        }
        const method = routeHandler.method;
        const middleware = routeHandler.middlewares;
        const exec = routeHandler.run.bind(routeHandler);
        flatApiRoutes[rootPath][method] = {
          exec,
          middleware,
        };
      }
    }
  }

  return flatApiRoutes;
}
