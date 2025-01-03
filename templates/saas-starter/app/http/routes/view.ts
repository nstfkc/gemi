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
    "/dashboard": this.view("Dashboard"),
  };
}

export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate"];

  override routes = {
    "/": this.view("Home", [HomeController, "index"]),
    "/auth": AuthViewRouter,
    "/app": AppRouter,
  };
}
