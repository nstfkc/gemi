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
