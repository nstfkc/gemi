import { HttpRequest, type Middleware } from "../../http";
import {
  type ApiRoutes,
  type RouteHandlers,
  type ApiRouter,
  type ResourceRoutes,
  RouteHandler,
  type ProxyHandler,
  type RouteSource,
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
      // Absent on a callback route, a proxy route and OPTIONS: none of them
      // runs a controller method.
      source?: RouteSource;
    }
  >
>;

function isRouteHandler(option: ApiRoutes[string]): option is RouteHandler<any, any, any, any> {
  return "run" in option;
}

function isRouteHandlers(option: ApiRoutes[string]): option is RouteHandlers {
  return (
    Object.hasOwn(option, "get") ||
    Object.hasOwn(option, "post") ||
    Object.hasOwn(option, "put") ||
    Object.hasOwn(option, "patch") ||
    Object.hasOwn(option, "delete")
  );
}

function isResouceRoutes(option: ApiRoutes[string]): option is ResourceRoutes<any> {
  return Object.hasOwn(option, "first") && Object.hasOwn(option, "second");
}

// Narrows to `typeof ApiRouter`, not `new () => ApiRouter`: the latter lacks
// the static `__brand` this very guard reads, so it is not a subtype of the
// parameter and TypeScript rejects the predicate under a strict lib.
function isApiRouter(routeHandlers: ApiRoutes[string]): routeHandlers is typeof ApiRouter {
  if ("__brand" in routeHandlers) {
    return routeHandlers.__brand === "ApiRouter";
  }
  return false;
}

function isProxyHandler(option: ApiRoutes[string]): option is ProxyHandler {
  if ("__internal_brand" in option) {
    return option.__internal_brand === "ProxyHandler";
  }
  return false;
}

function isStreamHandler(option: ApiRoutes[string]) {
  if ("__internal_brand" in option) {
    return option.__internal_brand === "StreamHandler";
  }
  return false;
}

/**
 * Strips `(group)` segments from an api path, as view routes do: a router
 * mounted at `"/(builds)"` (or `"(builds)/"`) adds no segment of its own, so
 * `/pages/(builds)/:pageId` is served at `/pages/:pageId`, the path `CreateRPC`
 * types it at (`RemoveGroupPrefix`). A group is a name of word characters and
 * `-` in parentheses. Parentheses right after a `:param` are its URLPattern
 * regex (`/:id(\\d+)`), as are parentheses holding anything but a name
 * (`/(\\d+)`); both are left for URLPattern to match.
 */
export function removeApiGroupSegments(path: string) {
  const stripped = path.replace(/(?<!:\w*)\([\w-]+\)/g, "");
  if (stripped === path) {
    return path;
  }
  const collapsed = `/${stripped}`.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
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
    source?: RouteSource,
  ) {
    const subPath = path === "/" ? "" : path;
    const _rootPath = rootPath === "/" ? "" : rootPath;
    const finalPath = removeApiGroupSegments(
      (`${_rootPath}${subPath}` === "" ? "/" : `${_rootPath}${subPath}`).replaceAll("//", "/"),
    );
    if (!flatApiRoutes[finalPath]) {
      flatApiRoutes[finalPath] = {};
    }
    flatApiRoutes[finalPath][method.toUpperCase()] = {
      exec,
      middleware: [...rootMiddleware, ...middleware],
      ...(source ? { source } : {}),
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
    if (isProxyHandler(option)) {
      const proxyHandler = option;
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        addRoute(path, method, proxyHandler.run.bind(proxyHandler), proxyHandler.middlewares);
      }
      continue;
    }

    if (isRouteHandler(option)) {
      const routeHandler = option;
      const method = routeHandler.method;
      const middleware = routeHandler.middlewares;
      const exec = routeHandler.run.bind(routeHandler);
      addRoute(path, method, exec, middleware, routeHandler.source);
      // A stream route also answers HEAD, so a client can read the size and
      // Accept-Ranges without pulling the body. It runs the same handler, so
      // it has the same source.
      if (isStreamHandler(option)) {
        addRoute(path, "HEAD", exec, middleware, routeHandler.source);
      }
    }

    if (isRouteHandlers(option)) {
      for (const [method, handler] of Object.entries(option)) {
        // At runtime every value is a `RouteHandler`: `FileHandler` and
        // `StreamHandler` construct one. Their types are kept apart only so
        // they stay out of the RPC client.
        const routeHandler = handler as RouteHandler<any, any, any, any>;
        const middleware = routeHandler.middlewares;
        const exec = routeHandler.run.bind(routeHandler);
        addRoute(path, method, exec, middleware, routeHandler.source);
        // `get: this.stream(...)` answers HEAD too, as a stream route on its
        // own path does. An explicit `head` key is not part of the map.
        if (method === "get" && isStreamHandler(routeHandler)) {
          addRoute(path, "HEAD", exec, middleware, routeHandler.source);
        }
      }
    }

    if (isApiRouter(option)) {
      const router = new option();
      // A nested router's routes run every enclosing router's `middlewares`
      // first, then its own, then the route's: the list is concatenated the
      // way view routers' are, and `MiddlewareRegistry` resolves it (a later
      // entry of the same alias replaces its params, a `-alias` removes it).
      const routes = createFlatApiRoutes(router.routes, `${rootPath}${path}`, [
        ...rootMiddleware,
        ...router.middlewares,
      ] as RouterMiddleware[] | string[]);
      // Merged per method rather than replaced: two routers mounted under
      // groups that share a prefix (`"/(builds)"` and `"/(edits)"`) can each
      // answer a different method on the same path.
      for (const [path, route] of Object.entries(routes)) {
        const key = path.replaceAll("//", "/");
        flatApiRoutes[key] = { ...flatApiRoutes[key], ...route };
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
        addRoute(rest.reverse().join("/"), method, exec, middleware, routeHandler.source);
      }
      for (const [method, routeHandler] of Object.entries(second)) {
        const middleware = routeHandler.middlewares;
        const exec = routeHandler.run.bind(routeHandler);
        addRoute(path, method, exec, middleware, routeHandler.source);
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
