import type { HttpRequest } from "../http/HttpRequest";
import { app } from "../foundation/app";
import { Translator } from "../i18n/Translator";
import { INTENDED_URL_PARAM } from "../utils/intendedUrl";
import { AuthManager } from "./AuthManager";

/**
 * The page a view request stands for, as the client router would `push` it:
 * without the `.json` / `.og` suffix of a data request, and without the locale
 * segment — `useNavigate` adds the current one back, and the sign-in page is
 * already under it by the time this is read, so keeping it would double it.
 */
export function intendedPathOf(req: HttpRequest, keepSearch = true): string {
  const url = new URL(req.rawRequest.url);
  let pathname = url.pathname.replace(/\.(json|og)$/, "");

  const [, maybeLocale, ...rest] = pathname.split("/");
  if (app(Translator).supportedLocales.includes(maybeLocale)) {
    pathname = `/${rest.join("/")}`;
  }

  return keepSearch ? `${pathname}${url.search}` : pathname;
}

/** Trailing slashes apart, since `/x` and `/x/` are the same page here. */
function samePath(a: string, b: string) {
  const trim = (value: string) => value.replace(/\/+$/, "") || "/";
  return trim(a) === trim(b);
}

/**
 * Where a signed-out request is sent: `signInPath` — the route's own, from
 * `"auth:/admin/sign-in"`, or else `auth.signInPath` — carrying the page the
 * request was for, so sign-in can return there.
 *
 * Only a view request carries one. An API request answers 401 and never
 * redirects, and a request outside any HTTP scope (a broadcast) has no page.
 */
export function signInLocation(req: HttpRequest | undefined, signInPath?: string): string {
  const path = signInPath || app(AuthManager).config.signInPath;
  // An absolute `signInPath` — sign-in hosted on another origin — keeps its
  // origin; a path stays a path. Anything else is a configuration mistake, and
  // it ends up in a `Location` and in a client-side `location.replace`, so it
  // is refused rather than redirected to: a bare `https` (what the route form
  // `"auth:https://sso.example/login"` truncates to, since the alias parser
  // splits on `:`) would otherwise send signed-out users to `/https`.
  const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(path);
  if (isAbsolute ? !/^https?:\/\//i.test(path) : !path.startsWith("/")) {
    throw new Error(
      `\`auth.signInPath\` must be a path like "/auth/sign-in", or an http(s) URL for sign-in hosted elsewhere. Got "${path}". A route's own \`"auth:<path>"\` cannot carry a URL, because the alias parser splits it on the colon.`,
    );
  }
  const target = new URL(path, "http://gemi.invalid");

  if (req?.kind === "view") {
    // Not the query string when sign-in is on another origin: a protected page
    // reached with a single-use token (`?invite=`, `?token=`) would hand it to
    // that origin, and to its logs and `Referer`.
    const intended = intendedPathOf(req, !isAbsolute);
    // Sending the sign-in page back to itself would only be a loop.
    if (isAbsolute || !samePath(new URL(intended, target).pathname, target.pathname)) {
      target.searchParams.set(INTENDED_URL_PARAM, intended);
    }
  }

  return isAbsolute ? target.href : `${target.pathname}${target.search}`;
}
