import { Middleware } from "./Middleware";
import { RequestContext } from "./requestContext";
import { AuthenticationError } from "./errors";
import { AuthManager } from "../auth/AuthManager";
import { signInLocation } from "../auth/signInRedirect";
import { app } from "../foundation/app";

/**
 * Refuses a request with no signed-in user: a 401 for an API route, and for a
 * view a redirect to the sign-in page carrying the page that was asked for —
 * `/auth/sign-in?redirect=%2Finvoices` — for `useIntendedUrl()` or
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
    const refuse = () => new AuthenticationError({ redirectTo: signInLocation(req, signInPath) });

    const accessTokenCookie = req.cookies.get("access_token");
    const accessTokenHeader = req.headers.get("access_token");

    const accessToken = accessTokenCookie || accessTokenHeader;

    if (!accessToken) {
      throw refuse();
    }

    let user = requestContextStore.user;

    if (!user) {
      const session = await app(AuthManager).getSession(accessToken, req.headers.get("User-Agent"));
      if (!session) {
        throw refuse();
      }
      user = session?.user;
      requestContextStore.setUser(user);
    }

    return {};
  }
}
