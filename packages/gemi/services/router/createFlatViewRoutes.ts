import type { HttpRequest } from "../../http";
import type { ViewRoutes } from "../../http/ViewRouter";

export type ViewRouteExec = (req: HttpRequest<any, any>) => any; // TODO: fix type

export type FlatViewRoutes = Record<
  string,
  { exec: ViewRouteExec[]; middleware: (string | any)[]; viewPath: string }
>;

function removeGroupPrefix(input: string) {
  // Remove all (str) patterns
  const withoutParentheses = input.replace(/\([^)]*\)/g, "");

  // Remove all double slashes // by replacing with single slash
  const withoutDoubleSlashes = withoutParentheses.replace(/\/\//g, "/");
  return withoutDoubleSlashes;
}

export function createFlatViewRoutes(routes: ViewRoutes) {
  const flatRoutes: FlatViewRoutes = {};

  for (const [routePath, viewConfigOrViewRouter] of Object.entries(routes)) {
    if ("run" in viewConfigOrViewRouter) {
      const route = viewConfigOrViewRouter;
      if ("children" in route) {
        const children = new route.children();
        const result = createFlatViewRoutes(children.routes);

        for (const [path, { exec, middleware }] of Object.entries(result)) {
          const key = routePath === "/" ? path : `${routePath}${path}`;
          const _key = path === "/" && routePath !== "/" ? routePath : key;

          const handler = (req: HttpRequest<any, any>) =>
            route.run.call(route, req, routePath);

          flatRoutes[removeGroupPrefix(_key)] = {
            exec: [handler, ...exec],
            middleware: [...route.middlewares, ...middleware],
            viewPath: route.viewPath,
          };
        }
      } else {
        const handler = (req: HttpRequest<any, any>) =>
          route.run.call(route, req, routePath);
        flatRoutes[removeGroupPrefix(routePath)] = {
          exec: [handler],
          middleware: route.middlewares,
          viewPath: route.viewPath,
        };
      }
    } else {
      const router = new viewConfigOrViewRouter();
      const result = createFlatViewRoutes(router.routes);
      for (const [path, { exec, middleware, viewPath }] of Object.entries(
        result,
      )) {
        const key = routePath === "/" ? path : `${routePath}${path}`;
        const _key = path === "/" && routePath !== "/" ? routePath : key;
        flatRoutes[removeGroupPrefix(_key)] = {
          exec,
          middleware: [...router.middlewares, ...middleware],
          viewPath,
        };
      }
    }
  }

  return Object.fromEntries(
    Object.entries(flatRoutes).sort(([a], [b]) => {
      const x = a.split("/").length + a.split(":").length;
      const y = b.split("/").length + b.split(":").length;
      return x - y;
    }),
  );
}
