import { HttpRequest, ViewRouter } from "gemi/http";

class AppRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/dashboard": this.view("Dashboard"),
  };
}

export default class extends ViewRouter {
  override routes = {
    "/": this.view("Home", (req: HttpRequest) => {
      req.ctx.setCookie("test", "test");
      return { data: {} };
    }),
    "/about": this.view("About"),
    "/app": AppRouter,
  };
}
