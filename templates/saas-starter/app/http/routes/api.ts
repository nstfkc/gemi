import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  middlewares = ["cache:private", "cors"];
  routes = {
    "/health": this.get(() => {
      return {};
    }),
  };
}
