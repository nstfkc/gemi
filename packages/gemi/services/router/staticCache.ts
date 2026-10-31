import type { StaticViewOptions } from "../../http/ViewRouter";

/**
 * Which of the cookies gemi sets on its own a view request gets.
 *
 * A hydrated view gets all three. A static view (`.static()`) gets none unless
 * it asked: it is one body for every visitor, and a per-visitor `Set-Cookie`
 * is what keeps a CDN from caching it. `i18n-locale` has no opt-in — the url
 * carries a static page's locale.
 */
export function staticCookiePolicy(staticView: StaticViewOptions | undefined) {
  if (!staticView) {
    return { locale: true, session: true, csrf: true };
  }
  return {
    locale: false,
    session: staticView.session === true,
    csrf: staticView.csrf === true,
  };
}

/**
 * Sets a static page's `Cache-Control` from `.static({ cacheControl })`.
 *
 * The handler's own header wins. A response that sets a cookie is never handed
 * to a shared cache, whatever the option says: one visitor's cookie stored with
 * the page would be replayed to everyone who gets that copy.
 */
export function applyStaticCacheControl(headers: Headers, staticView: StaticViewOptions) {
  if (headers.getSetCookie().length > 0) {
    if (staticView.cacheControl && process.env.NODE_ENV !== "production") {
      console.warn(
        `[gemi] A static view with cacheControl "${staticView.cacheControl}" set a cookie, so it was sent "private, no-store" instead. Static pages are cacheable only when nothing on them sets a cookie.`,
      );
    }
    headers.set("Cache-Control", "private, no-store");
    return;
  }
  if (staticView.cacheControl && !headers.has("Cache-Control")) {
    headers.set("Cache-Control", staticView.cacheControl);
  }
}

/**
 * Whether a shared cache may store this response: `public` or `s-maxage` in
 * its Cache-Control, as the static `dist/client` files carry
 * (`public, max-age=31536000`). A per-visitor cookie stored with such a
 * response would be handed to every visitor who gets that copy.
 */
export function sharedCacheable(response: Response) {
  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  return /(^|[\s,])(public|s-maxage)\b/.test(cacheControl);
}

/**
 * Takes every `Set-Cookie` off a response a shared cache may store (#1094). A
 * file route is an asset — a favicon, an image, a sitemap — and its caching
 * is the point of it, so the cookie goes rather than the caching, as on the
 * global-middleware path. The app's own cookie is reported in development.
 */
const warnedFileRoutes = new Set<string | null>();

export function dropCookiesFromSharedCacheable(response: Response, routePath: string | null) {
  if (!sharedCacheable(response) || response.headers.getSetCookie().length === 0) {
    return response;
  }
  if (process.env.NODE_ENV !== "production" && !warnedFileRoutes.has(routePath)) {
    warnedFileRoutes.add(routePath);
    console.warn(
      `[gemi] The file route "${routePath ?? ""}" set a cookie on a response with Cache-Control "${response.headers.get("Cache-Control")}", so the cookie was not sent: a shared cache would hand it to every visitor. Make the response private, or set the cookie elsewhere.`,
    );
  }
  try {
    response.headers.delete("Set-Cookie");
    return response;
  } catch {
    // A Response from fetch() has immutable headers.
    const headers = new Headers(response.headers);
    headers.delete("Set-Cookie");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
