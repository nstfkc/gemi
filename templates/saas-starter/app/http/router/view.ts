import { HttpRequest, ViewRouter } from "gemi/http";
import { HomeController } from "../controllers/HomeController";

class AppRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/": this.layout("app/AppLayout", {
      "/dashboard": this.view("Dashboard"),
    }),
  };
}

export default class extends ViewRouter {
  override routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home", [HomeController, "index"]),
    }),
    "/app": AppRouter,
  };
}
