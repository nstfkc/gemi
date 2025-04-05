import { HttpRequest, ViewRouter } from "gemi/http";

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
    }),
  };
}

export default class extends ViewRouter {
  middlewares = ["cache:public,12840,must-revalidate"];

  override routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home"),
      "/about": this.view("About", () => {
        return { title: "About" };
      }),
      "/pricing": this.view("Pricing", (req: HttpRequest) => {
        req.cookies.get("cookieName");
        req.headers.get("headerName");
        req.ctx().setCookie("foo", "bar", { httpOnly: true });
        return { title: "Pricing" };
      }),
    }),
    "/auth": AuthViewRouter,
    "(app)/": AppRouter,
  };
}
