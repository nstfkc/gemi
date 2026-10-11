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
import { Facade } from "./Facade";

export class Auth extends Facade {
  static getFacadeAccessor() {
    return AuthManager;
  }

  /**
   * The signed-in user. **Never resolves to `null`:** with no user it throws
   * `AuthenticationError` — a 401, and a redirect to sign-in for a view — which
   * the framework answers for you. On a route that also serves signed-out
   * visitors, use `Auth.userOrNull()` instead of catching it.
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
   */
  static async user(): Promise<User> {
    const user = await Auth.userOrNull();
    if (user) {
      return user;
    }
    throw new AuthenticationError({
      redirectTo: signInLocation(
        RequestContext.getStore()?.req,
        this.getFacadeRoot().config.signInPath,
      ),
    });
  }

  /**
   * The signed-in user, or `null` for a signed-out visitor — the same lookup
   * as `Auth.user()`, for a route that serves both:
   *
   * ```ts
   * const user = await Auth.userOrNull();
   * if (user) Redirect.to("/dashboard");
   * ```
   *
   * Only "nobody is signed in" becomes `null`. An error from the lookup itself,
   * such as the database being down, still throws, so an outage is not served
   * as a signed-out page.
   */
  static async userOrNull(): Promise<User | null> {
    const requestContextStore = RequestContext.getStore();

    if (requestContextStore?.user) {
      return requestContextStore.user;
    }

    const user = await sessionUser(this.getFacadeRoot(), requestContextStore?.req);
    if (user) {
      requestContextStore?.setUser(user);
    }
    return user;
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
