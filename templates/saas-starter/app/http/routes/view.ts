import { I18n, Query } from "gemi/facades";
import { type HttpRequest, ViewRouter } from "gemi/http";

class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
    "/reset-password": this.view("auth/ResetPassword"),
    "/forgot-password": this.view("auth/ForgotPassword"),
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
    "/": this.layout("PublicLayout", {
      "/": this.view("Home"),
      "/about": this.view("About", () => {
        // Query.prefetch("/test");
        return { title: "About" };
      }),
      "/pricing": this.view("Pricing", (req: HttpRequest) => {
        return { title: "Pricing" };
      }),
      "/test/:testId": this.view("Test", (req: HttpRequest) => {
        const result = {
          "en-US": "Hello",
          "tr-TR": "Merhaba",
        };

        return {
          message: result[req.locale()],
        };
      }),
    }),
    "/auth": AuthViewRouter,
    "(app)/": AppRouter,
  };
}
