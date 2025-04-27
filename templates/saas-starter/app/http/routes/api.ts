import { ApiRouter, ResourceController } from "gemi/http";

class ProductsController extends ResourceController {
  async list() {}
  async show() {}
  async store() {}
  async update() {}
  async delete() {}
}

class OrgRouter extends ApiRouter {
  routes = {
    "/:orgId/products/:productId": this.resource(ProductsController),
  };
}

export default class extends ApiRouter {
  middlewares = ["cache:private", "csrf"];

  routes = {
    "/org": OrgRouter,
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
