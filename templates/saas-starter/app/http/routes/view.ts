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

export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate"];

  override routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home", [HomeController, "index"]),
      "/:testId": this.view("Test"),
    }),
    "/auth": AuthViewRouter,
  };
}
