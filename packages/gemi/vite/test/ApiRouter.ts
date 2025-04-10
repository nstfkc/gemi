import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { Controller } from "../../http/Controller";

export default class extends ApiRouter {
  routes = {
    "/test": this.get((req: HttpRequest) => {
      return {};
    }).middleware(["test"]),
    "/foo": this.get((req: HttpRequest) => {
      return {};
    }),
  };
}
