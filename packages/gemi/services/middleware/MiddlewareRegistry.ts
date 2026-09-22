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

  /**
   * Throws on a `global` entry that would not run. A route's unknown alias is
   * skipped silently, which is survivable there; a global middleware is
   * usually a gate for the whole origin, and a typo in its alias would leave
   * every request ungated with nothing saying so. A `-alias` has nothing to
   * cancel in a list that nothing is inherited into.
   */
  assertGlobalMiddleware() {
    for (const entry of this.config.global) {
      if (typeof entry !== "string") {
        continue;
      }
      const [alias] = entry.split(":");
      if (alias.startsWith("-")) {
        throw new Error(
          `Global middleware "${entry}" cancels an alias, but nothing is inherited into the global list. Remove it.`,
        );
      }
      if (!this.aliases[alias]) {
        throw new Error(
          `Global middleware "${alias}" is not a registered alias. Add it to \`aliases\` in the middleware config, or list the class itself.`,
        );
      }
    }
  }

  /** The `global` list, run the way a route's list is. */
  public runGlobalMiddleware() {
    this.assertGlobalMiddleware();
    return this.runMiddleware(this.config.global);
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
