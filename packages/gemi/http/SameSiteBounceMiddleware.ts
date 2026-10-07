import { readAccessToken } from "../auth/accessToken";
import { RequestBreakerError } from "./Error";
import { Middleware } from "./Middleware";
import { RequestContext } from "./requestContext";

/** Marks the second, same-origin hop, so the bounce happens at most once. */
export const SAME_SITE_BOUNCE_PARAM = "gemi_same_site";

const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

/**
 * Lets a page that needs the session be the target of a redirect back from
 * another site: an OAuth connection's callback, a payment provider's return
 * URL.
 *
 * The `access_token` cookie is `SameSite=Strict`, so the browser leaves it off
 * a top-level navigation that another site started — the provider's redirect
 * back included. `auth` then sees nobody and sends a signed-in user to the
 * sign-in page. Listed ahead of `auth`, this answers such a request with a
 * tiny page that loads the same URL again from this origin
 * (`<meta http-equiv="refresh">`, no script). That second navigation is
 * same-site, the cookie goes with it, and `auth` runs as usual.
 *
 * ```ts
 * "/billing/return": this.view("BillingReturn", handler).middleware(["same-site-bounce", "auth"]),
 * ```
 *
 * with `"same-site-bounce": SameSiteBounceMiddleware` in the middleware
 * config's `aliases`. gemi's own `/auth/connections/:provider/callback` uses
 * it without one.
 *
 * It bounces only a page load (`GET`, not a `.json` navigation) that carries
 * no session token and no user, whose `Sec-Fetch-Site` is `cross-site` or
 * absent, and only once: the second hop carries `?gemi_same_site=1`, and if
 * there is still no session there the request goes on to `auth` and its
 * sign-in redirect. Nothing is read or consumed on the bounced hop, so the
 * route's own cookies (an OAuth `state`, which must be `SameSite=Lax` to
 * arrive at all) are still there for the second.
 */
export class SameSiteBounceMiddleware extends Middleware {
  run() {
    const store = RequestContext.getStore();
    const req = store?.req;
    if (!req || store.user) return {};

    const raw = req.rawRequest;
    if (req.kind !== "view" || (raw.method !== "GET" && raw.method !== "HEAD")) return {};

    const url = new URL(raw.url);
    if (/\.(json|og)$/.test(url.pathname)) return {};
    if (url.searchParams.has(SAME_SITE_BOUNCE_PARAM)) return {};
    if (readAccessToken(req)) return {};

    // `same-origin` / `same-site` would have carried the cookie, and `none`
    // (typed, bookmarked, opened by another app) does too: no cookie there
    // means signed out, and a bounce would not change that.
    const site = raw.headers.get("Sec-Fetch-Site");
    if (site && site !== "cross-site") return {};

    url.searchParams.set(SAME_SITE_BOUNCE_PARAM, "1");
    throw new SameSiteBounce(`${url.pathname}${url.search}`);
  }
}

/** The bounce page, as a request breaker so the dispatcher answers with it. */
export class SameSiteBounce extends RequestBreakerError {
  constructor(public location: string) {
    super("Same-site bounce");
    this.name = "SameSiteBounce";
    const href = escapeAttribute(location);
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": NO_STORE,
      // The URL carries the provider's one-time code.
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    };
    this.payload = {
      api: { status: 401, data: {}, headers: { "Cache-Control": NO_STORE } },
      // A `.json` navigation is same-origin and never bounced; should one get
      // here, the client router follows the same URL.
      viewData: {
        status: 200,
        data: {},
        headers: { "Cache-Control": NO_STORE },
        directive: { kind: "Redirect", path: location },
      },
      view: {
        status: 200,
        headers,
        body:
          `<!doctype html><html><head><meta charset="utf-8">` +
          `<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">` +
          `<meta http-equiv="refresh" content="0;url=${href}">` +
          `<title>Redirecting</title></head>` +
          `<body><p><a href="${href}">Continue</a></p></body></html>`,
      },
    };
  }
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
