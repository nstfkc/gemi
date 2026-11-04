import { SIGN_IN_HEADER } from "../http/refusal";
import { INTENDED_URL_PARAM, isExternalRedirect } from "../utils/intendedUrl";

/**
 * What happens when an `/api` query or mutation on an open page is refused
 * because nobody is signed in any more — the session expired while the tab
 * stayed open (#1119).
 *
 * A page load or a navigation already handles that: the server answers with a
 * redirect to sign-in. An `/api` request only gets a 401, which a query stores
 * as its error (keeping the data it had) and a mutation hands its caller. With
 * `onAuthenticationError` set on `init()`, gemi notices it once per incident
 * and lets the app react — `"redirect"` sends the tab to sign-in.
 *
 * **Not acted on blindly.** A 401 is confirmed first: gemi waits a moment and
 * asks `/auth/me` once, uncached. Only when that is refused as well is the
 * hook called. When `/auth/me` answers with a user (or anything else), the
 * refusal was not "signed out" — the failed queries are fetched again and
 * nothing else happens.
 *
 * **Only `authentication`.** An `authorization` or `permission` refusal (a
 * signed-in user who may not do this) is never reported; neither is `/auth/me`
 * itself, which a signed-out visitor on a public page is refused as a matter
 * of course.
 *
 * No DOM or React import at module scope: the module is reached from the
 * query cache, which also runs on the server.
 */

export interface AuthenticationErrorContext {
  /** What was refused first in this incident: a query or a mutation. */
  source: "query" | "mutation";
  /** The `/api` path that was refused, without `/api`. */
  path: string;
  /** The error as its caller saw it: a `QueryError`, or a `MutationError`. */
  error: unknown;
  /**
   * The sign-in page with the page on screen as `?redirect=` — the same
   * intended-URL contract `Auth.intendedUrl()` and `useIntendedUrl()` read.
   * The sign-in path is the one the server refused with (`auth.signInPath`, or
   * the route's own `"auth:/x"`). On another origin it carries the path only,
   * as the server's redirect does.
   */
  signInUrl: string;
  /** Sends the tab to `signInUrl`: through the router when it is a path here. */
  redirect(): void;
}

/**
 * `"redirect"` sends the tab to sign-in. A function is called instead, once
 * per incident, and decides: show a "your session expired" prompt, clear local
 * state, or call `ctx.redirect()` itself.
 */
export type OnAuthenticationError =
  | "redirect"
  | ((context: AuthenticationErrorContext) => void);

/** Where an older server, which sends no sign-in header, would have sent pages. */
export const DEFAULT_SIGN_IN_PATH = "/auth/sign-in";
/** How long after the refusal `/auth/me` is asked. */
export const AUTHENTICATION_RECHECK_DELAY_MS = 1000;
/**
 * How many inconclusive checks one page gets. A route refused for a reason
 * `/auth/me` does not share would otherwise check, refetch and be refused
 * again forever.
 */
export const MAX_AUTHENTICATION_RECHECKS = 2;

type HeaderSource = { get(name: string): string | null | undefined } | null | undefined;

interface Navigator {
  /** Navigate to a same-origin path, replacing the current entry. */
  replace(path: string): void;
  /** The page on screen, without the locale segment. */
  current(): { pathname: string; search: string } | null;
}

let handler: OnAuthenticationError | undefined;
let navigator: Navigator | null = null;
// `checking`: one `/auth/me` request is under way for this incident.
// `handled`: the hook ran; nothing more until the page changes.
let state: "idle" | "checking" | "handled" = "idle";
let rechecks = 0;
let refetches: Array<() => void> = [];

/** Called by `init()`. `undefined` turns it off, which is the default. */
export function configureAuthenticationErrors(option: OnAuthenticationError | undefined) {
  handler = option;
}

/** Called by the client router; returns the unregister function. */
export function setAuthenticationNavigator(next: Navigator) {
  navigator = next;
  return () => {
    if (navigator === next) navigator = null;
  };
}

/**
 * The page changed: a new incident may start. A check under way finishes on
 * its own, since its answer is still about this session.
 */
export function resetAuthenticationIncident() {
  if (state === "handled") state = "idle";
  rechecks = 0;
}

/** @internal For tests. */
export function resetAuthenticationErrorsForTests() {
  handler = undefined;
  navigator = null;
  state = "idle";
  rechecks = 0;
  refetches = [];
}

/**
 * Whether a response is an `authentication` refusal: a 401 whose `error` is
 * `{ kind: "authentication" }`, or the bare `"Authentication error"` a server
 * under `RequestBreakerError.legacyStringPayload` sends. An `AuthorizationError`
 * is a 401 too, and is told apart by its kind (or, as a string, by its
 * message: an `AuthenticationError` always says "Authentication error").
 */
export function isAuthenticationRefusal(status: number, body: unknown): boolean {
  if (status !== 401) return false;
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof error === "string") return error === "Authentication error";
  return (
    !!error && typeof error === "object" && (error as { kind?: unknown }).kind === "authentication"
  );
}

function signInPathFrom(headers: HeaderSource): string {
  const value = headers?.get?.(SIGN_IN_HEADER);
  if (typeof value !== "string" || value === "") return DEFAULT_SIGN_IN_PATH;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  return DEFAULT_SIGN_IN_PATH;
}

function currentPage(): { pathname: string; search: string } | null {
  const fromRouter = navigator?.current();
  if (fromRouter) return fromRouter;
  if (typeof window === "undefined") return null;
  return { pathname: window.location.pathname, search: window.location.search };
}

const trim = (path: string) => path.replace(/\/+$/, "") || "/";

/**
 * The sign-in URL for the page on screen, or `null` when that page is the
 * sign-in page itself — sending it back to itself would only be a loop.
 */
export function signInUrlFor(
  signInPath: string,
  page: { pathname: string; search: string },
): string | null {
  const external = isExternalRedirect(signInPath);
  const target = new URL(signInPath, "http://gemi.invalid");
  if (!external && trim(target.pathname) === trim(page.pathname)) return null;
  // Not the query string when sign-in is on another origin: a page reached
  // with a single-use token would hand it over — the server's rule too.
  target.searchParams.set(INTENDED_URL_PARAM, external ? page.pathname : `${page.pathname}${page.search}`);
  return external ? target.href : `${target.pathname}${target.search}`;
}

function go(url: string) {
  if (!isExternalRedirect(url) && navigator) {
    navigator.replace(url);
  } else {
    window.location.replace(url);
  }
}

/**
 * Reports a refused `/api` request. Returns at once; the check and the hook
 * run later. A no-op unless `onAuthenticationError` is set, outside a browser,
 * and for anything but an `authentication` refusal.
 *
 * `refetch` (queries) runs when the check finds the session alive.
 */
export function reportAuthenticationRefusal(report: {
  source: "query" | "mutation";
  path: string;
  status: number;
  body: unknown;
  headers: HeaderSource;
  error: unknown;
  refetch?: () => void;
}) {
  if (!handler || typeof window === "undefined") return;
  if (!isAuthenticationRefusal(report.status, report.body)) return;
  if (report.path.split("?")[0] === "/auth/me") return;
  if (state === "handled") return;
  if (state === "idle" && rechecks >= MAX_AUTHENTICATION_RECHECKS) return;
  if (report.refetch) refetches.push(report.refetch);
  if (state === "checking") return;

  state = "checking";
  rechecks++;
  const first = report;
  setTimeout(() => {
    void confirm(first);
  }, AUTHENTICATION_RECHECK_DELAY_MS);
}

async function confirm(first: {
  source: "query" | "mutation";
  path: string;
  headers: HeaderSource;
  error: unknown;
}) {
  let signedOut = false;
  // The refusal's own sign-in path wins: a route's `"auth:/x"` names its own.
  let headers: HeaderSource = first.headers?.get?.(SIGN_IN_HEADER) ? first.headers : null;
  try {
    const response = await fetch("/api/auth/me", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Not JSON: not an authentication refusal either.
    }
    signedOut = isAuthenticationRefusal(response.status, body);
    if (signedOut && !headers) headers = response.headers;
  } catch {
    // No answer at all: nothing is confirmed.
  }

  const pending = refetches;
  refetches = [];

  if (!signedOut) {
    state = "idle";
    for (const refetch of pending) {
      try {
        refetch();
      } catch (error) {
        console.error(error);
      }
    }
    return;
  }

  state = "handled";
  const page = currentPage();
  if (!page) return;
  const signInUrl = signInUrlFor(signInPathFrom(headers), page);
  if (!signInUrl) return;
  const context: AuthenticationErrorContext = {
    source: first.source,
    path: first.path,
    error: first.error,
    signInUrl,
    redirect: () => go(signInUrl),
  };
  try {
    if (handler === "redirect") context.redirect();
    else handler?.(context);
  } catch (error) {
    console.error(error);
  }
}
