import { ApiRouter, HttpRequest } from "gemi/http";

export default class extends ApiRouter {
  middlewares = ["cache:private", "cors"];
  routes = {
    "/health": this.get((req: HttpRequest) => {
      return {};
    }),
  };
}
