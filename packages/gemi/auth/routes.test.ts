import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { ViewRouteDispatcher } from "../services/router/ViewRouteDispatcher";
import { missingRequiredViewError } from "../server/requiredViews";
import type { AuthConfig } from "./config";
import { authViewRequirements } from "./routes";

process.env.SECRET ??= "test-secret";

/**
 * gemi's `/auth` view routes render views from the app's `app/views`. Each is
 * mounted only while the feature it serves is configured, so an app without
 * magic links or OAuth needs no file for them (#1040).
 */

class Api extends ApiRouter {
  routes = {};
}

class Views extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({})),
  };
}

const view = { root: createRoot(() => createElement("div")), rootRouter: Views };

const provider = {
  getRedirectUrl: async () => "https://idp.example/authorize",
  onCallback: async () => ({ providerId: "p1", email: "ada@example.com", emailVerified: true }),
};

function dispatcher(auth?: AuthConfig) {
  return new ViewRouteDispatcher(view, auth);
}

describe("the auth views mounted for a config", () => {
  test("by default: the magic-link page, and no OAuth views", () => {
    const d = dispatcher();
    expect(d.flatComponentTree).toContain("auth/MagicLinkSignIn");
    expect(d.flatComponentTree).not.toContain("auth/OauthCallback");
    expect(d.flatComponentTree).not.toContain("_Redirect");
    expect(Object.keys(d.flatViewRoutes)).toContain("/auth/sign-in/magic-link");
    expect(Object.keys(d.flatViewRoutes).some((path) => path.startsWith("/auth/oauth"))).toBe(false);
    expect(Object.keys(d.requiredViews)).toEqual(["auth/MagicLinkSignIn"]);
  });

  test("`magicLink: false`: no magic-link page, so no view to provide", () => {
    const d = dispatcher({ magicLink: false });
    expect(d.flatComponentTree).not.toContain("auth/MagicLinkSignIn");
    expect(Object.keys(d.flatViewRoutes)).not.toContain("/auth/sign-in/magic-link");
    expect(d.requiredViews).toEqual({});
  });

  test("`magicLink: false` with email codes on keeps the page their links open", () => {
    const d = dispatcher({ magicLink: false, emailCode: { enabled: true } });
    expect(Object.keys(d.flatViewRoutes)).toContain("/auth/sign-in/magic-link");
    expect(d.requiredViews).toEqual({ "auth/MagicLinkSignIn": "auth.emailCode.enabled" });
  });

  test("OAuth providers mount the redirect and callback views", () => {
    const d = dispatcher({ magicLink: false, oauthProviders: { google: provider } });
    expect(d.flatComponentTree).toEqual(expect.arrayContaining(["_Redirect", "auth/OauthCallback"]));
    expect(Object.keys(d.flatViewRoutes)).toEqual(
      expect.arrayContaining(["/auth/oauth/:provider", "/auth/oauth/:provider/callback"]),
    );
    expect(d.requiredViews).toEqual({
      _Redirect: "auth.oauthProviders (google)",
      "auth/OauthCallback": "auth.oauthProviders (google)",
    });
  });

  test("a provider behind a feature flag still counts as configured", () => {
    const d = dispatcher({ oauthProviders: { ig: { provider, feature: "ig" as never } } });
    expect(d.flatComponentTree).toContain("auth/OauthCallback");
  });

  test("the connection routes render no view and are always mounted", () => {
    const d = dispatcher({ magicLink: false });
    expect(Object.keys(d.flatViewRoutes)).toEqual(
      expect.arrayContaining(["/auth/connections/:provider", "/auth/connections/:provider/callback"]),
    );
  });

  test("the requirement names the setting and says the default is on", () => {
    expect(authViewRequirements({})).toEqual([
      {
        view: "auth/MagicLinkSignIn",
        requiredBy: "auth.magicLink (on by default; set `magicLink: false` to turn it off)",
      },
    ]);
    expect(authViewRequirements({ magicLink: true })[0].requiredBy).toBe("auth.magicLink");
  });
});

describe("what the servers learn from the app", () => {
  test("the app's `auth` config decides the views and their requirements", () => {
    class AppKernel extends Kernel {
      config = {
        auth: { magicLink: false, oauthProviders: { github: provider } },
        route: { api: { rootRouter: Api }, view },
      };
    }
    const app = new App({ kernel: AppKernel });

    expect(app.getFlatComponentTree()).not.toContain("auth/MagicLinkSignIn");
    expect(app.getFlatComponentTree()).toContain("auth/OauthCallback");
    expect(app.getRequiredViews()).toEqual({
      _Redirect: "auth.oauthProviders (github)",
      "auth/OauthCallback": "auth.oauthProviders (github)",
    });
  });

  test("an app without `auth` config needs only the magic-link page", () => {
    class AppKernel extends Kernel {
      config = { route: { api: { rootRouter: Api }, view } };
    }
    const app = new App({ kernel: AppKernel });

    expect(Object.keys(app.getRequiredViews())).toEqual(["auth/MagicLinkSignIn"]);
  });

  test("a missing required view fails with the file and the setting", () => {
    expect(missingRequiredViewError("auth/OauthCallback", "auth.oauthProviders (google)").message).toBe(
      "app/views/auth/OauthCallback.tsx is missing. gemi's auth routes render it because " +
        "auth.oauthProviders (google) is on. Add the view, or turn that setting off in app/config/auth.ts.",
    );
  });
});
