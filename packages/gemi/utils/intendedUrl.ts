/**
 * The search parameter carrying the page a signed-out visitor was trying to
 * reach. `AuthenticationMiddleware` writes it onto the sign-in redirect —
 * `/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2` — and `Auth.intendedUrl()` /
 * `useIntendedUrl()` read it back after sign-in.
 */
export const INTENDED_URL_PARAM = "redirect";

// Only ever compared against, never requested.
const PROBE_ORIGIN = "http://gemi.invalid";

/**
 * `value` if it is a path on this origin, `fallback` otherwise.
 *
 * The intended URL arrives in a query string anybody can write, so reading it
 * back unchecked is an open redirect: `?redirect=https://evil.example` signs
 * the user in and hands them to a look-alike. Only a same-origin path passes:
 * `//evil.example` and `/\evil.example` are protocol-relative to a browser and
 * are refused, as is anything a browser would strip control characters out of
 * before resolving.
 *
 * Returns path, search and hash — never an origin — so the result is safe to
 * hand to `push`, `Redirect.to` or a `Location` header alike.
 */
export function safeRedirectPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return fallback;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith("//")) {
    return fallback;
  }
  try {
    const url = new URL(value, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) {
      return fallback;
    }
    // `push` and `Redirect.to` run their path through `applyParams`, which
    // reads `:x` as a route parameter and collapses `//` — both legal in a
    // query (`?next=https://…`). Percent-encoded they mean the same to
    // `URLSearchParams` and survive the trip.
    const tail = `${url.search}${url.hash}`.replaceAll(":", "%3A").replaceAll("/", "%2F");
    return `${url.pathname}${tail}`;
  } catch {
    return fallback;
  }
}
