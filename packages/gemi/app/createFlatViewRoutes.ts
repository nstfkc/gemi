import type { HttpRequest } from "../http";
import type { ViewRoutes } from "../http/ViewRouter";

function removeGroupPrefix(input: string) {
  // Remove all (str) patterns
  const withoutParentheses = input.replace(/\([^)]*\)/g, "");

  // Remove all double slashes // by replacing with single slash
  const withoutDoubleSlashes = withoutParentheses.replace(/\/\//g, "/");
  console.log(input, withoutDoubleSlashes);

  return withoutDoubleSlashes;
}

export type ViewRouteExec = (req: HttpRequest<any, any>) => any; // TODO: fix type
export function createFlatViewRoutes(routes: ViewRoutes) {
  const flatRoutes: Record<
    string,
    { exec: ViewRouteExec[]; middleware: (string | any)[] }
  > = {};

  for (const [_routePath, viewConfigOrViewRouter] of Object.entries(routes)) {
    const routePath = removeGroupPrefix(_routePath);
    if ("run" in viewConfigOrViewRouter) {
      const route = viewConfigOrViewRouter;

      if ("children" in route) {
        const children = new route.children();
        const result = createFlatViewRoutes(children.routes);

        for (const [path, { exec, middleware }] of Object.entries(result)) {
          const key = routePath === "/" ? path : `${routePath}${path}`;
          const _key =
            path === "/" && routePath !== "/"
              ? routePath
              : removeGroupPrefix(key);

          flatRoutes[_key] = {
            exec: [route.run.bind(route), ...exec],
            middleware: [...route.middlewares, ...middleware],
          };
        }
      } else {
        flatRoutes[removeGroupPrefix(routePath)] = {
          exec: [route.run.bind(route)],
          middleware: route.middlewares,
        };
      }
    } else {
      const router = new viewConfigOrViewRouter();
      const result = createFlatViewRoutes(router.routes);
      for (const [_path, { exec, middleware }] of Object.entries(result)) {
        const path = removeGroupPrefix(_path);
        const key = routePath === "/" ? path : `${routePath}${path}`;
        const _key =
          path === "/" && routePath !== "/"
            ? routePath
            : removeGroupPrefix(key);
        flatRoutes[_key] = {
          exec,
          middleware: [...router.middlewares, ...middleware],
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
