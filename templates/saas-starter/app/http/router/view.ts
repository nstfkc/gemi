import { ViewRouter } from "gemi/http";
import { HomeController } from "../controllers/HomeController";
import { FooController } from "../controllers/FooController";

class AppRouter extends ViewRouter {
  // middlewares = ["auth", "cache"];

  routes = {
    "/": this.layout("app/AppLayout", {
      "/": this.view("Home", [HomeController, "index"]),
      "/dashboard": this.view("Dashboard", () => {
        return { title: "Dashboard" };
      }),
    }),
  };
}

class AuthViewRouter extends ViewRouter {
  middlewares = ["cache:public"];
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
    "/reset-password": this.view("auth/ResetPassword"),
    "/forgot-password": this.view("auth/ForgotPassword"),
  };
}

export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate"];

  override routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home", [HomeController, "index"]),
      "/:testId": this.view("Test"),
      "/foo": this.view("FooList", [FooController, "index"]),
      "/foo/:id": this.view("FooEdit", [FooController, "details"]),
      "/about": this.view("About", [HomeController, "about"]),
    }),
    "/app": AppRouter,
    "/auth": AuthViewRouter,
  };
}
