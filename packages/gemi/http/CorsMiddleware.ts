import { Middleware } from "./Middleware";

type CorsHeaders = {
  "Access-Control-Allow-Methods": string;
  "Access-Control-Allow-Headers": string;
  "Access-Control-Allow-Credentials": string;
};

const defaultHeaders: CorsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Credentials": "true",
};

/**
 * Sets CORS headers for a request whose `Origin` is a key of `origins`, or for
 * any origin when `origins` has a `"*"` key. An exact key wins over `"*"`.
 *
 * `"*"` answers `Access-Control-Allow-Origin: *` and leaves
 * `Access-Control-Allow-Credentials` out (browsers refuse the pair), so it suits
 * a public endpoint that takes no cookies — a form posted from any site.
 *
 * `Origin: null` (a sandboxed frame, a `file:` page) matches a `"null"` key or
 * `"*"`, and never gets `Access-Control-Allow-Credentials`.
 *
 * It answers no preflight: an `OPTIONS` request runs no middleware. A route
 * called with a token header or a JSON body from another origin declares a
 * `CorsPolicy` instead (`.cors()` on the route, `cors` on its router), which
 * gemi answers the preflight for.
 *
 * It runs on refusals too (`runsOnRefusal`): a `rate-limit` 429 or a
 * `body-limit` 413 from a middleware listed before it still carries its headers,
 * so the browser sees the status rather than a CORS failure.
 */
export class CorsMiddleware extends Middleware {
  static override runsOnRefusal = true;

  config = {
    origins: {
      "": {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Allow-Credentials": "true",
      },
    } as Record<string, Partial<CorsHeaders>>,
  };
  run() {
    const req = this.req;
    const origin = req.rawRequest.headers.get("Origin");
    if (origin && this.config.origins[origin]) {
      req.ctx().setHeaders("Access-Control-Allow-Origin", origin);
      const headers: Partial<CorsHeaders> = { ...defaultHeaders, ...this.config.origins[origin] };
      // Any site can send `Origin: null` (a sandboxed frame), so credentials
      // for it would be credentials for everyone (#913).
      if (origin === "null") {
        delete headers["Access-Control-Allow-Credentials"];
      }

      for (const [key, value] of Object.entries(headers)) {
        req.ctx().setHeaders(key, value);
      }
    } else if (origin && this.config.origins["*"]) {
      req.ctx().setHeaders("Access-Control-Allow-Origin", "*");
      const headers: Partial<CorsHeaders> = { ...defaultHeaders, ...this.config.origins["*"] };
      // Browsers refuse credentials with a wildcard origin.
      delete headers["Access-Control-Allow-Credentials"];

      for (const [key, value] of Object.entries(headers)) {
        req.ctx().setHeaders(key, value);
      }
    }

    return {};
  }
}
