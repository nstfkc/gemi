import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { HttpRequest } from "../../http/HttpRequest";
import { Controller } from "../../http/Controller";

class CustomReq extends HttpRequest {}

class TestController extends Controller {
  foo(req: CustomReq) {}
}

class TestRouter extends ApiRouter {
  routes = {
    "/": this.get(function (req: HttpRequest) {
      return null;
    }),
    "/asd": this.put((req: CustomReq) => {
      return null;
    }),
    "/foo": this.post(TestController, "foo"),
  };
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/": this.view("TEst", (req: HttpRequest) => {
      return {};
    }),
    "/x": this.layout("TEst", (req: HttpRequest) => {
      return {};
    }),
  };
}
