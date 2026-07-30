import { HttpRequest, Middleware, MiddlewareServiceProvider } from "../../http";
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
        map.set(alias, params.split(",").filter(Boolean));
      }
    } else {
      map.set(middleware, []);
    }
  }
  return map;
}

export class MiddlewareServiceContainer extends ServiceContainer {
  static _name = "MiddlewareServiceContainer";

  constructor(public service: MiddlewareServiceProvider) {
    super();
  }

  /**
   * Does this middleware chain gate access behind authentication?
   *
   * Runs the same `transformMiddleware` normalisation as `runMiddleware`, so a
   * `-auth` further down the chain cancels an earlier `auth` exactly the way it
   * does at request time. Aliases that aren't registered resolve to nothing and
   * are ignored, matching `runMiddleware`'s behaviour.
   */
  public isPrivateChain(
    middleware: (
      | string
      | RouterMiddleware
      | (new (req: HttpRequest) => Middleware)
    )[],
  ) {
    for (const key of transformMiddleware(middleware).keys()) {
      const Middleware =
        typeof key === "string" ? this.service.aliases[key] : key;

      if (isConstructor(Middleware) && (Middleware as any).isPrivate === true) {
        return true;
      }
    }
    return false;
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
          const Middleware = this.service.aliases[key];
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
