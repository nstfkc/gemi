import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { AuthController } from "./AuthController";

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

export class AuthViewRouter extends ViewRouter {
  middlewares = ["cache:private"];
  routes = {
    "/sign-in/magic-link": this.view("auth/MagicLinkSignIn", [
      AuthController,
      "signInWithMagicLink",
    ]),
    "/oauth": OAuthViewRouter,
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
  };
}
