import { I18n } from "gemi/facades";
import {
  ApiRouter,
  ResourceController,
  ValidationError,
  type HttpRequest,
} from "gemi/http";
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
    "/upload": this.post(async (req: HttpRequest<{ file: File }>) => {
      const input = await req.input();
      const file = input.get("file");
      throw new ValidationError({
        file: ["File is too large", "File type not allowed"],
      });
      return {
        filename: file.name,
        size: file.size,
        type: file.type,
      };
    }),
    "/health": this.get(() => {
      return {
        status: "ok",
      };
    }),
  };
}
