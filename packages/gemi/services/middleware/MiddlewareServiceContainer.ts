import { HttpRequest, Middleware, MiddlewareServiceProvider } from "../../http";
import { RequestContext } from "../../http/requestContext";
import type { RouterMiddleware } from "../../http/Router";
import { isConstructor } from "../../internal/isConstructor";
import { ServiceContainer } from "../ServiceContainer";

function transformMiddleware(input: (string | Function)[]) {
  const map = new Map();
  for (const middleware of input) {
    if (typeof middleware === "string") {
      const [alias, params = ""] = middleware.split(":");
      if (alias.startsWith("-")) {
        if (map.has(alias.replace("-", ""))) {
          map.delete(alias.replace("-", ""));
        }
      } else {
        map.set(alias, params.split(","));
      }
    } else {
      map.set(middleware, []);
    }
  }
  return map;
}

export class MiddlewareServiceContainer extends ServiceContainer {
  constructor(public service: MiddlewareServiceProvider) {
    super();
  }

  public runMiddleware(
    middleware: (
      | string
      | RouterMiddleware
      | (new (routePath: string) => Middleware)
    )[],
    routePath: string,
  ) {
    const req = RequestContext.getStore().req;

    return Array.from(transformMiddleware(middleware).entries())
      .map(([key, params]) => {
        if (typeof key === "string") {
          const Middleware = this.service.aliases[key];
          if (Middleware) {
            const middleware = new Middleware(routePath);
            return (req: HttpRequest) =>
              middleware.run.call(middleware, req, ...params);
          }
        } else {
          if (isConstructor(key)) {
            // TODO: fix type
            // @ts-ignore
            const middleware = new aliasOrTest(routePath);
            return middleware.run.bind(middleware);
          }
          return key;
        }
      })
      .filter(Boolean)
      .reduce(
        (acc: any, middleware: any) => {
          return async (req: HttpRequest<any, any>, ctx: any) => {
            return {
              ...(await acc(req, ctx)),
              ...(await middleware(req, ctx)),
            };
          };
        },
        (_req: HttpRequest<any, any>) => Promise.resolve({}),
      )(req);
  }
}
