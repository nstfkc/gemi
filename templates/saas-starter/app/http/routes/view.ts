import { Cookie, I18n, Meta, Query, Auth } from "gemi/facades";
import { type HttpRequest, ViewRouter } from "gemi/http";
import { PartialRenderController } from "../controllers/PartialRenderController";

class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
    "/reset-password": this.view("auth/ResetPassword"),
    "/forgot-password": this.view("auth/ForgotPassword"),
  };
}

/**
 * Hand-testable surface for partial rendering: navigating between two routes
 * under the same layout re-runs only the segments that changed. Each segment
 * renders the run number its handler stamped, so you can see which ones ran.
 */
class PartialRenderRouter extends ViewRouter {
  routes = {
    "/:orgId": this.layout("partial/Layout", [PartialRenderController, "layout"], {
      "/": this.view("partial/Overview", [PartialRenderController, "overview"]),
      "/reports": this.view("partial/Reports", [PartialRenderController, "reports"]),
      "/settings": this.layout(
        "partial/SettingsLayout",
        [PartialRenderController, "settingsLayout"],
        {
          "/general": this.view("partial/SettingsGeneral", [
            PartialRenderController,
            "settingsGeneral",
          ]),
          "/billing": this.view("partial/SettingsBilling", [
            PartialRenderController,
            "settingsBilling",
          ]),
        },
      ),
    }),
    // The same shape, opted out of being skipped.
    "/always/:orgId": this.layout(
      "partial/AlwaysLayout",
      [PartialRenderController, "alwaysLayout"],
      {
        "/one": this.view("partial/AlwaysOne", [PartialRenderController, "alwaysOne"]),
        "/two": this.view("partial/AlwaysTwo", [PartialRenderController, "alwaysTwo"]),
      },
    ).alwaysRun(),
  };
}

class AppRouter extends ViewRouter {
  middlewares = ["auth", "cache:private"];
  routes = {
    "/": this.layout("AppLayout", {
      "/dashboard": this.view("Dashboard"),
      "/inbox": this.view("Inbox"),
    }),
  };
}

export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate"];

  override routes = {
    "/": this.layout(
      "PublicLayout",
      () => {
        Meta.title("GEMI here");
        Meta.description("GEMI here");
        Meta.openGraph({
          title: "GEMI here",
          image: "/.og",
          type: "image/svg+xml",
          url: "https://gemiapp.com",
          imageWidth: 600,
          imageHeight: 400,
        });
        const isSet = Cookie.setIfAbsent("test", Math.random().toString(), {
          path: "/",
          maxAge: 3600,
        });

        console.log({ isSet });
      },
      {
        "/": this.view("Home", () => {
          Meta.title("GEMI here home page");
        }),
        "/about": this.view("About", (req: HttpRequest) => {
          // The search here must mirror what `About.tsx` queries with —
          // prefetched data is matched by variant (sorted search params).
          Query.prefetch("/test", { search: { locale: req.locale() } });
          return { title: "About" };
        }),
        "/pricing": this.view("Pricing", (req: HttpRequest) => {
          return { title: "Pricing" };
        }),
        "/testx": this.view("Test", async (req: HttpRequest) => {
          await Auth.authenticate("enesxtufekci@gmail.com");

          return {
            message: "This is a test message from the /test route.",
          };
        }).middleware("cache:private"),
      },
    ),
    "/auth": AuthViewRouter,
    "/partial": PartialRenderRouter,
    "(app)/": AppRouter,
  };
}
