import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { HttpRequest } from "../../http/HttpRequest";
import { Controller } from "../../http/Controller";

class CustomReq extends HttpRequest {}
export default class extends ApiRouter {
  routes = {
    "/test": this.get((req: HttpRequest) => {
      return {};
    }).middleware(["test"]),
    "/foo": this.get((req: CustomReq) => {
      return {};
    }),
  };
}
