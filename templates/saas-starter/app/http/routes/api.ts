import { I18n } from "gemi/facades";
import { ApiRouter, ResourceController, type HttpRequest } from "gemi/http";
import { Dictionary } from "gemi/i18n";

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
      return {
        message: Dictionary.text(
          {
            "en-US": "ok {{message}}",
            "tr-TR": "d'accord {{message:[test]}}",
          },
          { params: { message: (test) => test } },
        ),
      };
    }),
    "/health": this.get(() => {
      return {
        status: "ok",
      };
    }),
  };
}
