import { HttpRequest, ViewRouter } from "gemi/http";
import { HomeController } from "../controllers/HomeController";
import { Redirect } from "gemi/facades";

class AppRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/": this.layout("app/AppLayout", {
      "/": this.view("Dashboard", [HomeController, "index"]),
      "/dashboard": this.view("Dashboard", () => {
        return { title: "Dashboard" };
      }),
    }),
  };
}

export default class extends ViewRouter {
  override routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home", [HomeController, "index"]),
      "/:testId": this.view("Test", (req: HttpRequest) => {
        return { testId: req.params.testId };
      }),
      "/about": this.view("About", [HomeController, "about"]),
    }),
    "/app": AppRouter,
  };
}
