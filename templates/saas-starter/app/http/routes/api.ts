import { ApiRouter, ResourceController, type HttpRequest } from "gemi/http";

class OrgController extends ResourceController {}

class OrgRouter extends ApiRouter {
  routes = {
    "/:orgId": this.resource(OrgController),
  };
}

export default class extends ApiRouter {
  middlewares = ["cache:private"];

  routes = {
    "/org": OrgRouter,
    "/health": this.get(() => {
      return {
        status: "ok",
      };
    }),
  };
}
