import { HttpRequest, ViewRouter } from "gemi/http";

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
      "/": this.view("Home", (req: HttpRequest) => {
        req.ctx.setCookie("test", "test");
        return { data: {} };
      }),
    }),
    "/app": AppRouter,
  };
}
