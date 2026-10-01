import type { User } from "../auth/types";
import { AuthManager } from "../auth/AuthManager";
import { sessionUser } from "../auth/accessToken";
import { signInLocation } from "../auth/signInRedirect";
import { INTENDED_URL_PARAM, safeRedirectPath } from "../utils/intendedUrl";
import {
  AuthenticationError,
  InsufficientPermissionsError,
} from "../http/errors";
import { RequestContext } from "../http/requestContext";
import { Broadcast } from "./Broadcast";
import { Facade } from "./Facade";

export class Auth extends Facade {
  static getFacadeAccessor() {
    return AuthManager;
  }

  /**
   * The signed-in user, or an `AuthenticationError` — a 401, and a redirect to
   * sign-in for a view.
   *
   * Agrees with the `auth` middleware on who that is, so a route with it and a
   * route without it see the same user:
   *
   * - **A user on the request context** is returned as it is: one a global
   *   middleware or a route middleware put there, or one an earlier lookup
   *   found. See "Who counts as signed in" in docs/middleware.md.
   * - **Otherwise the `access_token` cookie or header** is looked up, through
   *   the same reader the middleware uses, and the user found is put on the
   *   context for the rest of the request.
   *
   * On a broadcasting connection the token is read from the socket's upgrade
   * request the same way, so a native client with no cookie jar authenticates
   * with the header.
   */
  static async user(): Promise<User> {
    const requestContextStore = RequestContext.getStore();

    let user: User | null = requestContextStore?.user;

    if (!user) {
      const broadcastingContextStore =
        Broadcast.getFacadeRoot().context.getStore();
      // A socket's upgrade request when there is one, as before; else the
      // request's own.
      const source = broadcastingContextStore ?? requestContextStore?.req;
      user = await sessionUser(this.getFacadeRoot(), source);
      if (user) {
        requestContextStore?.setUser(user);
      }
    }

    if (user) {
      return user;
    }
    throw new AuthenticationError({
      redirectTo: signInLocation(
        requestContextStore?.req,
        this.getFacadeRoot().config.signInPath,
      ),
    });
  }

  /**
   * Where to send a user who has just signed in: the page they were turned
   * away from, which `AuthenticationMiddleware` put on the sign-in URL as
   * `?redirect=`, or `auth.redirectPath` when there is none.
   *
   * Reads the current request's query, so call it from the sign-in page's own
   * loader or from a controller the sign-in page posts to with its query
   * forwarded. Anything but a path on this origin is ignored — the parameter
   * is attacker-writable, and passing it on unchecked is an open redirect.
   *
   * ```ts
   * Redirect.to(Auth.intendedUrl() as any);
   * ```
   */
  static intendedUrl(fallback?: string): string {
    const req = RequestContext.getStore()?.req;
    return safeRedirectPath(
      req?.search.get(INTENDED_URL_PARAM),
      fallback ?? this.getFacadeRoot().config.redirectPath,
    );
  }

  static async guard(
    fn: (user: User) => Promise<boolean> | boolean,
  ): Promise<void> {
    // With no user this throws `AuthenticationError` (401, and a redirect to
    // sign-in for a view), before `fn` ever runs. Only a known user can be
    // refused with the 403 below.
    const user = await Auth.user();

    // An error thrown by `fn` propagates as itself. Turning it into a 403 would
    // report a database outage to the client as "you may not do this" and hide
    // it from `onRequestFail`; it still refuses the request either way.
    if (!(await fn(user))) {
      throw new InsufficientPermissionsError();
    }
  }

  static async guardSafe(
    fn: (user: User) => Promise<boolean> | boolean,
  ): Promise<boolean> {
    // Like `guard`, this throws `AuthenticationError` with no user; `false`
    // means a known user the predicate refused.
    const user = await Auth.user();

    try {
      return await fn(user);
    } catch (err) {
      return false;
    }
  }

  static async authenticate(email: string) {
    const container = this.getFacadeRoot();
    return await container.authenticate(email);
  }

  static async createMagicLink(email: string) {
    const container = this.getFacadeRoot();
    return await container.createMagicLinkToken(email);
  }
}
