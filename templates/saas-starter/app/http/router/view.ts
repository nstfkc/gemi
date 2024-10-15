import { HttpRequest, ViewRouter } from "gemi/http";
import { HomeController } from "../controllers/HomeController";
import { FooController } from "../controllers/FooController";

class AppRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/": this.layout("app/AppLayout", {
      "/": this.view("Home", [HomeController, "index"]),
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
      "/:testId": this.view("Test"),
      "/foo": this.view("FooList", [FooController, "index"]),
      "/foo/:id": this.view("FooEdit", [FooController, "details"]),
      "/about": this.view("About", [HomeController, "about"]),
    }),
    "/app": AppRouter,
  };
}
