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
export function intendedPathOf(req: HttpRequest): string {
  const url = new URL(req.rawRequest.url);
  let pathname = url.pathname.replace(/\.(json|og)$/, "");

  const [, maybeLocale, ...rest] = pathname.split("/");
  if (app(Translator).supportedLocales.includes(maybeLocale)) {
    pathname = `/${rest.join("/")}`;
  }

  return `${pathname}${url.search}`;
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
  // origin; a path stays a path.
  const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(path);
  const target = new URL(path, "http://gemi.invalid");

  if (req?.kind === "view") {
    const intended = intendedPathOf(req);
    // Sending the sign-in page back to itself would only be a loop.
    if (isAbsolute || new URL(intended, target).pathname !== target.pathname) {
      target.searchParams.set(INTENDED_URL_PARAM, intended);
    }
  }

  return isAbsolute ? target.href : `${target.pathname}${target.search}`;
}
