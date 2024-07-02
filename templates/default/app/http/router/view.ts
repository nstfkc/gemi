import { ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  override routes = {
    "/": this.view("Home"),
  };
}
