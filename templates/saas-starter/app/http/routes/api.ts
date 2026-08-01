import { WelcomeEmail } from "@/app/email/WelcomeEmail";
import { I18n } from "gemi/facades";
import { ApiRouter, ResourceController, ValidationError, type HttpRequest } from "gemi/http";
import { Dictionary } from "gemi/i18n";
import { HomeController } from "../controllers/HomeController";
import { PartialRenderController } from "../controllers/PartialRenderController";
import { SuspenseDemoController } from "../controllers/SuspenseDemoController";

class ProductsController extends ResourceController {
  async list() {}
  async show() {}
  async store() {}
  async update(req: HttpRequest<{ id: 1 }>) {}
  async delete() {}
}

class OrgRouter extends ApiRouter {
  routes = {
    "/:orgId/products/:productId": this.resource(ProductsController),
  };
}

let health = 0;

export default class extends ApiRouter {
  middlewares = ["cache:private"];

  routes = {
    "/org": OrgRouter,
    "/test": this.get(HomeController, "index"),
    // Read by the `/partial` demo — see PartialRenderController for which of
    // these are prefetched on the server and which the browser has to fetch.
    "/partial-render/org/:orgId": this.get(PartialRenderController, "org"),
    "/partial-render/reports": this.get(PartialRenderController, "reportsData"),
    "/partial-render/notifications": this.get(PartialRenderController, "notifications"),
    // Read by the `/suspense` demo — all artificially slow so suspension is
    // visible; `flaky` fails twice and succeeds on the third call.
    "/suspense-demo/products": this.get(SuspenseDemoController, "products"),
    "/suspense-demo/metrics": this.get(SuspenseDemoController, "metrics"),
    "/suspense-demo/flaky": this.get(SuspenseDemoController, "flaky"),
    "/home": this.post(HomeController, "post"),
    "/upload": this.post(async (req: HttpRequest<{ file: File | File[] }>) => {
      const input = await req.input();
      const file = input.get("file");
      const files = Array.isArray(file) ? file : [file];

      return files.map((file) => {
        return {
          filename: file.name,
          size: file.size,
          type: file.type,
        };
      });
    }),
    "/health": this.get(() => {
      return {
        status: Math.random() > 0.95 ? "ok" : "error",
      };
    }),
    "/dict/:id": this.get(async (req: HttpRequest<{ id: string }>) => {
      const { id } = req.params;
      if (id === "test") {
        return {
          hello: "world",
          foo: "bar",
        };
      } else {
        throw new Error("No dict");
      }
    }),
    "/proxy": this.proxy("http://localhost:3000/api/test"),
  };
}
