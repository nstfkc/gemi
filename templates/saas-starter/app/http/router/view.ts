import { HttpRequest, ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  override routes = {
    "/": this.view("Home"),
    "/about": this.view("About"),
  };
}
