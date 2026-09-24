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
    // query (`?next=https://…`) and in a path. Percent-encoded they mean the
    // same to `URLSearchParams` and survive the trip; left raw, `?redirect=/:x`
    // throws in dev and navigates to `/undefined` in production.
    const tail = `${url.search}${url.hash}`.replaceAll("/", "%2F");
    const path = `${url.pathname}${tail}`.replaceAll(":", "%3A");
    // The `//` test above reads the input, but `.` and `..` segments are
    // resolved away by `new URL` afterwards, and resolving them can *produce* a
    // leading `//`: `/..//evil.example` normalizes to `//evil.example`, which is
    // protocol-relative to a browser. Test what actually goes out.
    return path.startsWith("//") ? fallback : path;
  } catch {
    return fallback;
  }
}

/**
 * Whether the client addressed this request over https — through the proxy in
 * front if there is one, since TLS is nearly always terminated before the app
 * and a forged `X-Forwarded-Proto` only spoils the forger's own cookie.
 *
 * Not `origin.includes("localhost")`: the URL is built from the `Host` header,
 * so `localhost.evil.example` would read as local and drop `Secure`.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded ? forwarded === "https" : new URL(request.url).protocol === "https:";
}

/**
 * Whether a `Redirect` directive names somewhere outside the router — an
 * absolute http(s) URL or a protocol-relative one — and so has to leave the
 * page rather than be looked up as a route.
 *
 * Only those two shapes. The value goes to `location.replace`, and *any*
 * scheme that parses would include `javascript:`, which runs in this document
 * rather than navigating away from it: an app passing a user-influenced value
 * to `Redirect.external` would be handing out same-origin script execution.
 * Anything else falls through to the router, which cannot leave the origin.
 */
export function isExternalRedirect(path: string | null | undefined): boolean {
  return /^(https?:\/\/|\/\/)/i.test(path ?? "");
}
