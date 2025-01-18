import { HttpRequest, Middleware } from "../../http";
import {
  type ApiRoutes,
  type RouteHandlers,
  type FileHandler,
  type ApiRouter,
} from "../../http/ApiRouter";
import type { RouterMiddleware } from "../../http/Router";
import { toCamelCase } from "../../utils/toCamelCase";

type ApiRouteExec = any;

function corsHandler() {
  const req = new HttpRequest();

  const headers = req.ctx().headers;

  console.log(headers);

  return new Response(null, { headers, status: 204 });
}
function isRouter(
  routeHandlers: RouteHandlers | FileHandler | (new () => ApiRouter),
): routeHandlers is new () => ApiRouter {
  if ("__brand" in routeHandlers) {
    return routeHandlers.__brand === "ApiRouter";
  }
  return false;
}

export type FlatApiRoutes = Record<
  string,
  Record<
    string,
    {
      exec: ApiRouteExec;
      middleware: (string | (new () => Middleware) | RouterMiddleware)[];
    }
  >
>;

export function createFlatApiRoutes(routes: ApiRoutes, prevPath: string = "") {
  const flatApiRoutes: FlatApiRoutes = {};
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
        middleware,
      };
      flatApiRoutes[rootPath]["OPTIONS"] = {
        exec: () => corsHandler(),
        middleware,
      };
    } else if (typeof apiRouteHandlerOrApiRouter === "function") {
      let routes: ApiRoutes = {};
      let routerMiddlewares = [];
      if (isRouter(apiRouteHandlerOrApiRouter)) {
        const router = new apiRouteHandlerOrApiRouter();
        routes = router.routes;
        routerMiddlewares = [router.middleware, ...router.middlewares];
      } else {
        const [lastSegment] = (rootPath === "/" ? prevPath : rootPath)
          .split("/")
          .reverse();

        if (lastSegment === "") {
          throw new Error(`"${rootPath}" is not valid for a resource route`);
        }
        if (lastSegment.includes(":")) {
          throw new Error(
            `Last segment of a resource route has to be static. See "${rootPath}"`,
          );
        }
        routes = apiRouteHandlerOrApiRouter(`${toCamelCase(lastSegment)}Id`);
      }

      const result = createFlatApiRoutes(routes, rootPath);
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
            middleware: [...routerMiddlewares, ...handler.middleware],
          };
          flatApiRoutes[finalPath]["OPTIONS"] = {
            exec: () => corsHandler(),
            middleware: [...routerMiddlewares, ...handler.middleware],
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
        flatApiRoutes[rootPath]["OPTIONS"] = {
          exec: () => corsHandler(),
          middleware,
        };
      }
    }
  }

  return Object.fromEntries(
    Object.entries(flatApiRoutes).sort(([a], [b]) => {
      const x = a.split("/").length + a.split(":").length;
      const y = b.split("/").length + b.split(":").length;
      return x - y;
    }),
  );
}
