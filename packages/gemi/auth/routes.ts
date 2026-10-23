import { ApiRouter } from "../http/ApiRouter";
import { SameSiteBounceMiddleware } from "../http/SameSiteBounceMiddleware";
import { ViewRouter, type ViewRoutes } from "../http/ViewRouter";
import type { AuthConfig } from "./config";
import { AuthController } from "./AuthController";
import { ConnectionsController } from "./connections/ConnectionsController";

/**
 * The views gemi's auth router renders from the application's `app/views`,
 * each with the config that turns it on (#1040). A view whose feature is off
 * is not routed, so an app without the feature needs no file for it.
 */
export interface AuthViewRequirement {
  /** The view name, as under `app/views` without `.tsx`. */
  view: string;
  /** The config that requires it, for the error a missing file throws. */
  requiredBy: string;
}

/**
 * The magic-link page takes the links `POST /auth/magic-link` mails and the
 * ones `emailCode.send` is handed, so it is on while either is.
 */
function magicLinkPageEnabled(config: AuthConfig) {
  return config.magicLink !== false || config.emailCode?.enabled === true;
}

function oauthEnabled(config: AuthConfig) {
  return Object.keys(config.oauthProviders ?? {}).length > 0;
}

/** Which application views the auth router needs under `config`, and why. */
export function authViewRequirements(config: AuthConfig = {}): AuthViewRequirement[] {
  const views: AuthViewRequirement[] = [];
  if (magicLinkPageEnabled(config)) {
    views.push({
      view: "auth/MagicLinkSignIn",
      requiredBy:
        config.emailCode?.enabled === true && config.magicLink === false
          ? "auth.emailCode.enabled"
          : `auth.magicLink${config.magicLink === undefined ? " (on by default; set `magicLink: false` to turn it off)" : ""}`,
    });
  }
  if (oauthEnabled(config)) {
    const names = Object.keys(config.oauthProviders ?? {}).join(", ");
    const requiredBy = `auth.oauthProviders (${names})`;
    views.push({ view: "_Redirect", requiredBy }, { view: "auth/OauthCallback", requiredBy });
  }
  return views;
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

/**
 * gemi's `/auth` view routes for `config`: the magic-link page while
 * `auth.magicLink` (or `auth.emailCode.enabled`) is on, the OAuth sign-in
 * routes while `auth.oauthProviders` has an entry, and the connection routes,
 * which render no view, always.
 */
export function createAuthViewRouter(config: AuthConfig = {}): new () => ViewRouter {
  const magicLink = magicLinkPageEnabled(config);
  const oauth = oauthEnabled(config);

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

  return class AuthViewRouter extends ViewRouter {
    middlewares = ["cache:private"];
    routes: ViewRoutes = {
      ...(magicLink
        ? {
            "/sign-in/magic-link": this.view("auth/MagicLinkSignIn", [
              AuthController,
              "signInWithMagicLink",
            ]),
          }
        : {}),
      ...(oauth ? { "/oauth": OAuthViewRouter } : {}),
      "/connections": ConnectionsViewRouter,
    };
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
