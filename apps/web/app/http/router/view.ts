import { ViewRouter } from "gemi/http";
import { AuthController } from "../controllers/AuthController";
import { HomeController } from "../controllers/HomeController";

class AuthViewRouter extends ViewRouter {
  middlewares = ["user"];

  override routes = {
    "/sign-in": this.view("auth/SignIn", [AuthController, "signInView"]),
  };
}

export default class extends ViewRouter {
  override routes = {
    "/": this.view("Home", [HomeController, "index"]),
    "/foo": this.layout("FooLayout", {
      "/": this.view("Foo", [HomeController, "foo"]),
      "/bar": this.view("Bar", (req) => {
        return {
          message: req.url,
        };
      }),
    }),
  };
}
