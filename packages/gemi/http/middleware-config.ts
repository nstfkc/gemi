import type { HttpRequest } from "./HttpRequest";
import type { Middleware } from "./Middleware";

type MiddlewareClass = new (req: HttpRequest) => Middleware;

// Config key: `middleware`. Derived from `MiddlewareServiceProvider`.
export interface MiddlewareConfig {
  aliases?: Record<string, MiddlewareClass>;
  /**
   * Runs, in order, on every request the server receives — static files
   * included — before the router matches a route and before any route
   * middleware. Each entry is a middleware class or an alias from `aliases`,
   * with `alias:param` arguments as in a route's list. See `docs/middleware.md`.
   */
  global?: (string | MiddlewareClass)[];
  /**
   * The request body limit for every api route without a `body-limit` of its
   * own: bytes, or a size such as `"1mb"`. A route's `body-limit:…` replaces
   * it, raising it as well as lowering it (`body-limit:none` lifts it). Unset,
   * only Bun's server-wide `maxRequestBodySize` applies. See
   * `docs/middleware.md`.
   */
  bodyLimit?: string | number | null;
}

export function defineMiddlewareConfig(
  config: MiddlewareConfig,
): MiddlewareConfig {
  return config;
}

export function middlewareConfigDefaults(): Required<MiddlewareConfig> {
  return {
    aliases: {},
    global: [],
    bodyLimit: null,
  };
}
