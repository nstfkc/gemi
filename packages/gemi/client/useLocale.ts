import { useLocation } from "./useLocation";
import { useNavigate } from "./useNavigate";
import { useParams } from "./useParams";
import { useRouteData } from "./useRouteData";

const LOCALE_COOKIE = "i18n-locale";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The active locale lives in two places: the URL segment `setLocale` navigates
 * to, and the `i18n-locale` cookie the server falls back to when the URL has no
 * segment — which is exactly the case for the default locale. Both have to be in
 * place *before* the navigation asks for route data, or `Translator.detectLocale`
 * answers the request with a redirect back to the locale the cookie still names.
 *
 * Hence a synchronous `document.cookie` write rather than an awaited one. The
 * previous implementation awaited `cookieStore.set()` and hung the navigation off
 * its `.then()`; that promise is reported to never settle on iOS Safari, so the
 * `.then()` never ran and changing the language became a silent no-op — no
 * rejection, nothing for an error reporter to pick up. A synchronous write cannot
 * hang and cannot fail asynchronously, so nothing is left to gate navigation on.
 */
function persistLocale(locale: string) {
  if (typeof document === "undefined") {
    return;
  }
  try {
    document.cookie = [
      `${LOCALE_COOKIE}=${locale}`,
      `Max-Age=${LOCALE_COOKIE_MAX_AGE}`,
      "SameSite=Strict",
      "Path=/",
    ].join("; ");
  } catch {
    // A sandboxed iframe with no storage access throws here. The navigation
    // still carries the locale in its URL, so it is better to switch without
    // remembering the choice than to not switch at all.
  }
}

export function useLocale() {
  const { i18n } = useRouteData();
  const { pathname, search } = useLocation();
  const { replace } = useNavigate();
  const params = useParams();

  const setLocale = async (locale: string) => {
    persistLocale(locale);

    // `onLocaleChange` is a server-side hook, so it needs a request to fire —
    // but the language switch must not wait on a round trip, nor be cancelled
    // by one that fails. Fire and forget: the route re-sets the same cookie,
    // which is already correct locally either way.
    void fetch(`/api/__gemi__/services/i18n/set-locale/${locale}`).catch(
      () => {},
    );

    const urlSearchParams = new URLSearchParams(search);
    await replace(pathname, {
      locale,
      // TODO: fix: this conversion is wrong, because there can be multiple
      // search params with the same name
      search: Object.fromEntries(urlSearchParams.entries()),
      params,
    } as any);
  };

  return [i18n.currentLocale, setLocale] as const;
}
