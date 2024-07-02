import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    "/health-check": this.get(() => {
      return { status: "ok" };
    }),
  };
}
