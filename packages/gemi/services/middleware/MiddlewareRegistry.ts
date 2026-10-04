import { HttpRequest, Middleware } from "../../http";
import { BodyLimitMiddleware } from "../../http/BodyLimitMiddleware";
import { hasBodyLimit, parseByteSize, setBodyLimit } from "../../http/bodyLimit";
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

/**
 * Aliases that work without an entry in the app's `aliases`, which replace them
 * when they name the same alias. Only for middleware whose absence would be
 * silent and unsafe: an unknown alias is skipped, so a `body-limit:64kb` on a
 * public route that the app forgot to register would bound nothing.
 */
const builtinAliases: Record<string, new (req: HttpRequest) => Middleware> = {
  "body-limit": BodyLimitMiddleware,
};

export class MiddlewareRegistry {
  static token = "middleware";

  /** `config.bodyLimit` in bytes, or `null`. Parsed once, here. */
  readonly defaultBodyLimit: number | null;

  constructor(public config: Required<MiddlewareConfig>) {
    this.defaultBodyLimit =
      config.bodyLimit === null || config.bodyLimit === undefined
        ? null
        : parseByteSize(config.bodyLimit);
  }

  get aliases(): Record<string, new (req: HttpRequest) => Middleware> {
    return { ...builtinAliases, ...this.config.aliases };
  }

  /**
   * Installs the app-wide `bodyLimit` on an api request that has no limit yet.
   * Its `Content-Length` is checked when the body is read rather than now, so
   * a route's own `body-limit`, which runs after this, can still raise it.
   */
  applyDefaultBodyLimit(request: Request) {
    if (this.defaultBodyLimit !== null && !hasBodyLimit(request)) {
      setBodyLimit(request, this.defaultBodyLimit, { checkDeclared: false });
    }
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

  /**
   * The `global` list, run the way a route's list is.
   *
   * It does not re-check the list: `MiddlewareServiceProvider.boot` has
   * already thrown on a bad entry, a boot failure stops `gemi start`, and the
   * config is not written to afterwards. This runs on every request the server
   * takes, static files included, so the check belongs at boot and only there.
   */
  public runGlobalMiddleware() {
    return this.runMiddleware(this.config.global);
  }

  public runMiddleware(
    middleware: (string | RouterMiddleware | (new (req: HttpRequest) => Middleware))[],
  ) {
    const req = new HttpRequest();
    const aliases = this.aliases;
    return Array.from(transformMiddleware(middleware).entries())
      .map(([key, params]) => {
        if (typeof key === "string") {
          const Middleware = aliases[key];
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
