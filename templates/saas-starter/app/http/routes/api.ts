import { ApiRouter, HttpRequest } from "gemi/http";

export default class extends ApiRouter {
  middlewares = ["cache:private", "cors"];
  routes = {
    "/health": this.get((req: HttpRequest) => {
      const locale = req.locale();
      return {
        locale,
      };
    }),
  };
}
