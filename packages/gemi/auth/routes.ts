import { ApiRouter } from "../http/ApiRouter";
import { SameSiteBounceMiddleware } from "../http/SameSiteBounceMiddleware";
import { ViewRouter } from "../http/ViewRouter";
import { AuthController } from "./AuthController";
import { ConnectionsController } from "./connections/ConnectionsController";

class OAuthViewRouter extends ViewRouter {
  middlewares = ["cache:private"];
  routes = {
    "/:provider": this.view("_Redirect", [AuthController, "oauthRedirect"]),
    "/:provider/callback": this.view("auth/OauthCallback", [
      AuthController,
      "oauthCallback",
    ]),
  };
}

/** OAuth connections (#845): connect the signed-in user's account at a provider. */
class ConnectionsViewRouter extends ViewRouter {
  middlewares = ["cache:private"];
  routes = {
    "/:provider": this.redirect([ConnectionsController, "connect"]).middleware(["auth"]),
    // The provider's redirect back is a cross-site navigation, which the
    // `SameSite=Strict` session cookie does not ride along on: the bounce
    // reloads it from this origin before `auth` looks for the user.
    "/:provider/callback": this.redirect([ConnectionsController, "callback"]).middleware([
      SameSiteBounceMiddleware as unknown as string,
      "auth",
    ]),
  };
}

export class AuthViewRouter extends ViewRouter {
  middlewares = ["cache:private"];
  routes = {
    "/sign-in/magic-link": this.view("auth/MagicLinkSignIn", [
      AuthController,
      "signInWithMagicLink",
    ]),
    "/oauth": OAuthViewRouter,
    "/connections": ConnectionsViewRouter,
  };
}

export class AuthApiRouter extends ApiRouter {
  middlewares = ["cache:private"];
  routes = {
    "/sign-in": this.post(AuthController, "signIn"),
    "/sign-in-v2": this.post(AuthController, "signInV2"),
    "/sign-up": this.post(AuthController, "signUp"),
    "/sign-out": this.post(AuthController, "signOut"),
    "/forgot-password": this.post(AuthController, "forgotPassword"),
    "/reset-password": this.post(AuthController, "resetPassword"),
    "/change-password": this.post(AuthController, "changePassword"),
    "/verify-email": this.post(AuthController, "verifyEmail"),
    "/me": this.get(AuthController, "me").middleware(["auth"]),
    "/magic-link": this.post(AuthController, "createMagicLinkToken"),
    "/sign-in-with-pin": this.post(AuthController, "signInWithPin"),
    "/sign-in-with-pin-v2": this.post(AuthController, "signInWithPinV2"),
    // Sign-up-or-sign-in with a one-time email code (#708). 404 unless
    // `auth.emailCode.enabled`.
    "/email-code": this.post(AuthController, "requestEmailCode"),
    "/email-code/verify": this.post(AuthController, "verifyEmailCode"),
  };
}
