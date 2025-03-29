import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  middlewares = ["cache:private"];

  routes = {
    "/health": this.get(() => {
      return {
        status: "ok",
      };
    }),
  };
}
