import { ViewRouter } from "gemi/http";
import { HomeController } from "../controllers/HomeController";

export default class extends ViewRouter {
  override routes = {
    "/": this.view("Home", [HomeController, "index"]),
    "/about": this.view("About"),
  };
}
