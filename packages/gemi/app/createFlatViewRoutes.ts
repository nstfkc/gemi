import { ViewChildren, ViewRouteExec } from "../http/ViewRouter";

export function createFlatViewRoutes(routes: ViewChildren) {
  const flatRoutes: Record<
    string,
    { exec: ViewRouteExec[]; middleware: (string | any)[] }
  > = {};

  for (const [routePath, viewConfigOrViewRouter] of Object.entries(routes)) {
    if ("prepare" in viewConfigOrViewRouter) {
      const route = viewConfigOrViewRouter.prepare();

      if (Object.entries(route.children).length > 0) {
        const result = createFlatViewRoutes(route.children);

        if (route.kind === "view") {
          flatRoutes[routePath] = {
            exec: [route.exec],
            middleware: route.middlewares,
          };
        }

        for (const [path, { exec, middleware }] of Object.entries(result)) {
          const key = routePath === "/" ? path : `${routePath}${path}`;
          const _key = path === "/" && routePath !== "/" ? routePath : key;
          flatRoutes[_key] = {
            exec,
            middleware: [...route.middlewares, ...middleware],
          };
        }
      } else {
        flatRoutes[routePath] = {
          exec: [route.exec],
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
