import { ApiRouter, HttpRequest, ResourceController } from "gemi/http";

class TestController extends ResourceController {
  async list(req: HttpRequest<any, any>) {}
  async show(req: HttpRequest<any, any>) {}
  store(req: HttpRequest<any, any>) {}
  delete(req: HttpRequest<any, any>) {}
  update(req: HttpRequest<any, any>) {}
}

export default class extends ApiRouter {
  middlewares = ["cache:private", "cors"];
  routes = {
    "/health": this.get((req: HttpRequest) => {
      const locale = req.locale();
      return {
        locale,
      };
    }),
    "/orders/:orderId": this.resource(TestController),
  };
}
