import { ViewRouter } from "gemi/http";
import { HomeController } from "@/app/http/controllers/HomeController";

class AuthViewRouter extends ViewRouter {
  middlewares = ["cache:public"];
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
    "/reset-password": this.view("auth/ResetPassword"),
    "/forgot-password": this.view("auth/ForgotPassword"),
  };
}

class AppRouter extends ViewRouter {
  middlewares = ["auth"];
  routes = {
    "/dashboard": this.view("Dashboard", () => ({
      breadcrumb: "Dashboard",
    })),
  };
}

export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate"];

  override routes = {
    "/": this.layout("AppLayout", () => ({ breadcrumb: "App layout" }), {
      "/": this.view("Home", [HomeController, "index"]),
      "/about": this.view("About", () => {
        return { breadcrumb: "About" };
      }),
    }),
    "/auth": AuthViewRouter,
    "/app": AppRouter,
  };
}
