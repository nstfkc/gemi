import { parseByteSize, setBodyLimit } from "./bodyLimit";
import { Middleware } from "./Middleware";

export interface BodyLimitMiddlewareConfig {
  /** The limit when the DSL gives none: bytes, or a size such as `"64kb"`. */
  limit?: string | number;
}

/**
 * Bounds a route's request body (#752).
 *
 * ```
 * "body-limit:64kb"   // 413 past 64 KiB
 * "body-limit:1.5mb"
 * "body-limit:none"   // lifts the app-wide `bodyLimit` default for this route
 * ```
 *
 * A declared `Content-Length` over the limit is refused here, before the
 * handler runs or anything is read. A chunked body is counted as it is read —
 * by `req.input()`, `req.rawRequest.text()`, a proxy route's forwarded stream —
 * and refused once it passes the limit, without buffering past it. See
 * `bodyLimit.ts`.
 *
 * `body-limit` is built in: it works without an entry in `aliases`. An app
 * alias of the same name replaces it.
 */
export class BodyLimitMiddleware extends Middleware<BodyLimitMiddlewareConfig> {
  run(limit?: string) {
    const value = limit ?? this.config.limit;
    if (value === undefined || value === "") {
      throw new Error('`body-limit` needs a size, as in "body-limit:64kb".');
    }
    setBodyLimit(this.req.rawRequest, parseByteSize(value));
    return {};
  }
}
