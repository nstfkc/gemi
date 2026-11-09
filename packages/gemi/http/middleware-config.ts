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
   * own: bytes, or a size such as `"1mb"`. `"1mb"` unless set. A route's
   * `body-limit:…` replaces it, raising it as well as lowering it
   * (`body-limit:none` lifts it). `null` (or `"none"`) turns the default off,
   * leaving only Bun's server-wide `maxRequestBodySize`. See
   * `docs/middleware.md`.
   */
  bodyLimit?: string | number | null;
  /**
   * The default for upload routes, `"50mb"` unless set: a multipart body whose
   * schema has file rules (`file`, `fileType`, `fileSize:…`) gets this or its
   * `fileSize` ceilings plus `bodyLimit`, whichever is larger, instead of
   * `bodyLimit`. Also what `body-limit:upload` and an agent's `upload` route
   * use. Does nothing while `bodyLimit` is off.
   */
  uploadBodyLimit?: string | number;
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
    bodyLimit: "1mb",
    uploadBodyLimit: "50mb",
  };
}
