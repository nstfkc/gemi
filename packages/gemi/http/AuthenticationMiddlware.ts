import { Middleware } from "./Middleware";
import { RequestContext } from "./requestContext";
import { AuthenticationError } from "./errors";
import { AuthManager } from "../auth/AuthManager";
import { signInLocation } from "../auth/signInRedirect";
import { app } from "../foundation/app";
import { sessionUser } from "../auth/accessToken";

/**
 * Refuses a request with no signed-in user: none on the request context, and
 * no `access_token` cookie or header naming a live session. An API route gets
 * a 401, and a view a redirect to the sign-in page carrying the page that was
 * asked for — `/auth/sign-in?redirect=%2Finvoices` — for `useIntendedUrl()` or
 * `Auth.intendedUrl()` to send the user back to once they sign in.
 *
 * The sign-in page is `signInPath` in the auth config. A route that needs a
 * different one names it as the alias parameter:
 *
 * ```ts
 * "/admin": this.view("Admin").middleware(["auth:/admin/sign-in"]),
 * ```
 */
export class AuthenticationMiddleware extends Middleware {
  async run(signInPath?: string) {
    const requestContextStore = RequestContext.getStore();
    const req = requestContextStore.req;

    // A user already on the context passes, token or not. It was put there by
    // code that runs before this one — a global middleware, a route middleware
    // listed ahead of `auth`, or a lookup like this one — and that code is the
    // app's own, so a user it set is one it vouches for: an SSO header a proxy
    // in front of the app wrote, an API key it checked (#577). Nothing in gemi
    // puts a user there from request data it has not verified. The flip side
    // is that an app's middleware must never `setUser` anyone it has not
    // authenticated; see "Who counts as signed in" in docs/middleware.md.
    if (requestContextStore.user) {
      return {};
    }

    const user = await sessionUser(app(AuthManager), req);
    if (!user) {
      throw new AuthenticationError({ redirectTo: signInLocation(req, signInPath) });
    }
    requestContextStore.setUser(user);

    return {};
  }
}
