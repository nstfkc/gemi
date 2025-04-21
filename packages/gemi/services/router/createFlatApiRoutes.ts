import { HttpRequest, type Middleware } from "../../http";
import {
  type ApiRoutes,
  type RouteHandlers,
  type ApiRouter,
  type ResourceRoutes,
  RouteHandler,
} from "../../http/ApiRouter";
import type { RouterMiddleware } from "../../http/Router";

type ApiRouteExec = any;
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

function isRouteHandler(
  option: ApiRoutes[string],
): option is RouteHandler<any, any, any, any> {
  return "run" in option;
}

function isRouteHandlers(option: ApiRoutes[string]): option is RouteHandlers {
  return (
    Object.hasOwn(option, "get") ||
    Object.hasOwn(option, "post") ||
    Object.hasOwn(option, "put") ||
    Object.hasOwn(option, "delete")
  );
}

function isResouceRoutes(
  option: ApiRoutes[string],
): option is ResourceRoutes<any> {
  return Object.hasOwn(option, "first") && Object.hasOwn(option, "second");
}

function isApiRouter(
  routeHandlers: ApiRoutes[string],
): routeHandlers is new () => ApiRouter {
  if ("__brand" in routeHandlers) {
    return routeHandlers.__brand === "ApiRouter";
  }
  return false;
}

export function createFlatApiRoutes(
  routes: ApiRoutes,
  rootPath = "",
  rootMiddleware: RouterMiddleware[] | string[] = [],
) {
  const flatApiRoutes: FlatApiRoutes = {};

  function addRoute(
    path: string,
    method: string,
    exec: ApiRouteExec,
    middleware: RouterMiddleware[] | string[],
  ) {
    const subPath = path === "/" ? "" : path;
    const _rootPath = rootPath === "/" ? "" : rootPath;
    const finalPath = (
      `${_rootPath}${subPath}` === "" ? "/" : `${_rootPath}${subPath}`
    ).replaceAll("//", "/");
    if (!flatApiRoutes[finalPath]) {
      flatApiRoutes[finalPath] = {};
    }
    flatApiRoutes[finalPath][method.toUpperCase()] = {
      exec,
      middleware: [...rootMiddleware, ...middleware],
    };
    flatApiRoutes[finalPath].OPTIONS = {
      exec: () => {
        const req = new HttpRequest();
        const headers = req.ctx().headers;
        return new Response(null, { headers, status: 204 });
      },
      middleware: [],
    };
  }

  for (const [path, option] of Object.entries(routes)) {
    if (isRouteHandler(option)) {
      const routeHandler = option;
      const method = routeHandler.method;
      const middleware = routeHandler.middlewares;
      const exec = routeHandler.run.bind(routeHandler);
      addRoute(path, method, exec, middleware);
    }

    if (isRouteHandlers(option)) {
      for (const [method, routeHandler] of Object.entries(option)) {
        const middleware = routeHandler.middlewares;
        const exec = routeHandler.run.bind(routeHandler);
        addRoute(path, method, exec, middleware);
      }
    }

    if (isApiRouter(option)) {
      const router = new option();
      const routes = createFlatApiRoutes(
        router.routes,
        `${rootPath}${path}`,
        router.middlewares,
      );
      for (const [path, route] of Object.entries(routes)) {
        flatApiRoutes[path.replaceAll("//", "/")] = route;
      }
    }

    if (isResouceRoutes(option)) {
      const { first, second } = option;
      for (const [method, routeHandler] of Object.entries(first)) {
        const middleware = routeHandler.middlewares;
        const exec = routeHandler.run.bind(routeHandler);
        const [lastSegment, ...rest] = path.split("/").reverse();
        if (!lastSegment.startsWith(":")) {
          throw new Error("Resource route must end with a dynamic segment");
        }
        addRoute(rest.reverse().join("/"), method, exec, middleware);
      }
      for (const [method, routeHandler] of Object.entries(second)) {
        const middleware = routeHandler.middlewares;
        const exec = routeHandler.run.bind(routeHandler);
        addRoute(path, method, exec, middleware);
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
