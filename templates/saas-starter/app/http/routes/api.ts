import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  middlewares = ["cache:private", "csrf"];

  routes = {
    "/test": this.post(() => {
      return {};
    }),
    "/health": this.get(() => {
      return {
        status: "ok",
      };
    }),
  };
}
