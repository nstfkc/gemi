import { HttpRequest, Middleware } from "../../http";
import type { MiddlewareConfig } from "../../http/middleware-config";
import type { RouterMiddleware } from "../../http/Router";
import { isConstructor } from "../../internal/isConstructor";

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
        map.set(alias, params.split(",").filter(Boolean));
      }
    } else {
      map.set(middleware, []);
    }
  }
  return map;
}

export class MiddlewareRegistry {
  static token = "middleware";

  constructor(public config: Required<MiddlewareConfig>) {}

  get aliases() {
    return this.config.aliases;
  }

  public runMiddleware(
    middleware: (
      | string
      | RouterMiddleware
      | (new (req: HttpRequest) => Middleware)
    )[],
  ) {
    const req = new HttpRequest();
    return Array.from(transformMiddleware(middleware).entries())
      .map(([key, params]) => {
        if (typeof key === "string") {
          const Middleware = this.aliases[key];
          if (Middleware) {
            const middleware = new Middleware(req);
            return () => middleware.run.call(middleware, ...params);
          }
        } else {
          if (isConstructor(key)) {
            const middleware = new key(req);
            return middleware.run.bind(middleware);
          }
          return key;
        }
      })
      .filter(Boolean)
      .reduce(
        (acc: any, middleware: any) => {
          return async () => {
            return {
              ...(await acc()),
              ...(await middleware()),
            };
          };
        },
        () => Promise.resolve({}),
      )();
  }
}
