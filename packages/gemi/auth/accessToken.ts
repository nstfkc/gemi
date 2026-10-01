import type { User } from "./types";

/** The name of gemi's session credential, as a cookie and as a header. */
export const ACCESS_TOKEN = "access_token";

/**
 * Anything that carries a request's credentials: an `HttpRequest`, or the
 * headers and parsed cookies of a broadcasting connection.
 */
export interface AccessTokenSource {
  cookies: { get(name: string): string | null | undefined };
  headers: { get(name: string): string | null | undefined };
}

/**
 * The access token `source` carries: the `access_token` cookie a browser
 * sends, or else the `access_token` header a native client sends. `null` when
 * it carries neither.
 *
 * The one place gemi reads the token. `AuthenticationMiddleware`,
 * `Auth.user()` (a request's and a broadcasting connection's) and sign-out used
 * to read it each in their own way, and disagreed on whether the header
 * counted — so a header client was signed in on a route carrying `auth` and
 * refused on one without it (#587).
 *
 * An empty cookie — what a sign-out leaves a client that ignored the clearing
 * `Set-Cookie` — counts as no cookie, so a header beside it is still read.
 * When both are present the cookie wins, as it always has.
 *
 * Reading a token is not authenticating: it is only a claim until
 * `AuthManager.getSession` finds a live session for it. See `sessionUser`.
 */
export function readAccessToken(source: AccessTokenSource | null | undefined): string | null {
  return source?.cookies?.get(ACCESS_TOKEN) || source?.headers?.get(ACCESS_TOKEN) || null;
}

/**
 * The user whose live session `source`'s access token names, or `null` when
 * it carries no token, or one with no session, an expired one included.
 *
 * Takes the manager rather than resolving it, so the facade's own accessor —
 * and a test's stand-in for it — is the one asked.
 */
export async function sessionUser(
  auth: { getSession(token: string, userAgent: string): Promise<{ user?: User } | null> },
  source: AccessTokenSource | null | undefined,
): Promise<User | null> {
  const token = readAccessToken(source);
  if (!token) {
    return null;
  }
  // Passed on as the request carried it, absent included, exactly as each
  // reader did before; a user provider may store and compare it.
  const session = await auth.getSession(token, source.headers.get("User-Agent") as string);
  return session?.user ?? null;
}
