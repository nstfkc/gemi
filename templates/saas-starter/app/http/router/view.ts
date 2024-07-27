import { HttpRequest, ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  override routes = {
    "/": this.view("Home", (req: HttpRequest) => {
      req.ctx.setCookie("test", "test");
      return { data: {} };
    }),
    "/about": this.view("About"),
  };
}
