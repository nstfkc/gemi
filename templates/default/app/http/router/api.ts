import { ApiRouter } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    "/health-check": this.get(async () => {
      return { status: "ok" };
    }),
  };
}
