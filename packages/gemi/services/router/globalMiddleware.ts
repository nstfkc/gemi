import { app } from "../../foundation/app";
import { GEMI_REQUEST_BREAKER_ERROR } from "../../http/Error";
import { HttpRequest } from "../../http/HttpRequest";
import { RequestContext } from "../../http/requestContext";
import { isPolicyDeniedError } from "../../orm/errors";
import { MiddlewareRegistry } from "../middleware/MiddlewareRegistry";
import { breakResponse, mergeContextIntoResponse } from "./ApiRouteDispatcher";
import { isApiPath } from "./apiPath";
import { policyDeniedResponse, policyDeniedView } from "./policyDenied";
import { viewBreakResponse, viewDataBreakResponse } from "./ViewRouteDispatcher";

export interface GlobalMiddlewareOutcome {
  /** The response that ends the request, when a global middleware refused it. */
  refusal: Response | null;
  /**
   * Puts the headers and cookies the global middleware set on the request
   * context onto the response the request ends with. The response's own
   * headers win; the context only fills gaps, as it does for route middleware.
   * Cookies are left off a response a shared cache may store (see
   * `sharedCacheable`).
   */
  apply(response: Response): Response;
}

/**
 * Whether a shared cache may store this response: `public` or `s-maxage` in
 * its Cache-Control, as the static `dist/client` files carry
 * (`public, max-age=31536000`). A per-visitor cookie a global middleware set
 * would otherwise be stored with the asset, and a CDN that caches responses
 * with Set-Cookie would hand it to every visitor who gets that copy.
 */
function sharedCacheable(response: Response) {
  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  return /(^|[\s,])(public|s-maxage)\b/.test(cacheControl);
}

const noCookies = new Set<string>();

const passThrough: GlobalMiddlewareOutcome = {
  refusal: null,
  apply: (response) => response,
};

/**
 * Runs the `global` middleware list for one incoming request, before anything
 * is routed and before a static file is served. Called from `App`, once per
 * request (see `App.withGlobalMiddleware`), inside the kernel scope.
 *
 * It opens a request scope of its own. The router has not run, so the
 * `HttpRequest` a global middleware gets has no params and an empty
 * `routePath`, and its `kind` is read off the url the way `App.fetch` picks a
 * dispatcher. The scope is not the one the route later runs in: the route's
 * dispatcher opens a fresh one, as it always has, so a user or locale a global
 * middleware puts on the context is not seen by the route. Headers and cookies
 * are the exception, and reach the response through `apply`.
 *
 * A break answers the way the same break from a route middleware would for
 * that url: the api's JSON for `/api`, the `.json` navigation's body for view
 * data, and the page response otherwise, static files included. A policy
 * denial is the same 403 the dispatchers give. Anything else is thrown, and
 * the caller answers it as the server's 500.
 */
export async function runGlobalMiddleware(req: Request): Promise<GlobalMiddlewareOutcome> {
  const registry = app(MiddlewareRegistry);
  if (registry.config.global.length === 0) {
    return passThrough;
  }

  const { pathname } = new URL(req.url);
  const isApi = isApiPath(pathname);
  const httpRequest = new HttpRequest(req, {}, isApi ? "api" : "view", "");

  return await RequestContext.run(httpRequest, async () => {
    const ctx = RequestContext.getStore();
    // Held past `destroy()` below, which only drops the store's references.
    const { headers, cookies } = ctx;
    const apply = (response: Response) => {
      if (!sharedCacheable(response)) {
        return mergeContextIntoResponse(response, headers, cookies);
      }
      const withoutCookies = new Headers(headers);
      withoutCookies.delete("Set-Cookie");
      return mergeContextIntoResponse(response, withoutCookies, noCookies);
    };

    try {
      await registry.runGlobalMiddleware();
      return { refusal: null, apply };
    } catch (err) {
      const isViewData = !isApi && pathname.endsWith(".json");
      if (err?.kind === GEMI_REQUEST_BREAKER_ERROR) {
        const refusal = isApi
          ? breakResponse(err.payload.api)
          : isViewData
            ? viewDataBreakResponse(err.payload.viewData ?? err.payload.api)
            : viewBreakResponse(err.payload.view);
        return { refusal: apply(refusal), apply };
      }
      if (isPolicyDeniedError(err)) {
        console.error(err);
        const refusal =
          isApi || isViewData ? policyDeniedResponse() : viewBreakResponse(policyDeniedView());
        return { refusal: apply(refusal), apply };
      }
      throw err;
    } finally {
      ctx.destroy();
    }
  });
}
