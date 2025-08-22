import { I18n } from "gemi/facades";
import { ApiRouter, ResourceController, type HttpRequest } from "gemi/http";

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
    "/test": this.get((req: HttpRequest) => {
      const result = {
        "en-US": "Hello",
        "tr-TR": "Merhaba",
      };

      const locale = I18n.locale() ?? "en-US";
      return {
        message: "Test223",
      };
    }),
    "/health": this.get(() => {
      return {
        status: "ok",
      };
    }),
  };
}
