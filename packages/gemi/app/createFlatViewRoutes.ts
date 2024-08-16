import { ViewRoutes, ViewHandler } from "../http/ViewRouter";

export function createFlatViewRoutes(routes: ViewRoutes) {
  const flatRoutes: Record<
    string,
    { exec: ViewHandler<any, any, any>[]; middleware: (string | any)[] }
  > = {};

  for (const [routePath, viewConfigOrViewRouter] of Object.entries(routes)) {
    if ("run" in viewConfigOrViewRouter) {
      const route = viewConfigOrViewRouter;

      if ("children" in route) {
        const children = new route.children();
        const result = createFlatViewRoutes(children.routes);

        for (const [path, { exec, middleware }] of Object.entries(result)) {
          const key = routePath === "/" ? path : `${routePath}${path}`;
          const _key = path === "/" && routePath !== "/" ? routePath : key;

          flatRoutes[_key] = {
            exec: [route.run.bind(route), ...exec],
            middleware: [...route.middlewares, ...middleware],
          };
        }
      } else {
        flatRoutes[routePath] = {
          exec: [route.run.bind(route)],
          middleware: route.middlewares,
        };
      }
    } else {
      const router = new viewConfigOrViewRouter();
      const result = createFlatViewRoutes(router.routes);
      for (const [path, { exec, middleware }] of Object.entries(result)) {
        const key = routePath === "/" ? path : `${routePath}${path}`;
        const _key = path === "/" && routePath !== "/" ? routePath : key;
        flatRoutes[_key] = {
          exec,
          middleware: [...router.middlewares, ...middleware],
        };
      }
    }
  }

  return flatRoutes;
}
