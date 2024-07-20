import { ApiRouter, Controller, HttpRequest } from "gemi/http";

export default class extends ApiRouter {
  routes = {
    "/health-check": this.get(async (req: TestRequest) => {
      const input = await req.input();
      input.get("id");
      return { status: "ok" };
    }),
    "/test": TestRouter,
  };
}

class NestedRouter extends ApiRouter {
  routes = {
    "/nested": this.post(async (req: HttpRequest<{ id: string }>) => {
      const input = await req.input();
      input.get("id");
      return { status: "ok" };
    }),
  };
}

type Product = {
  id: string;
  name: string;
};

class ProductController extends Controller {
  async update(req: HttpRequest<{ name: string }>) {
    const product = {} as Product;
    return { product };
  }
}
class TestRequest extends HttpRequest<{
  id: string;
}> {
  schema = {
    id: { string: "hi" },
  };
}
class TestRouter extends ApiRouter {
  routes = {
    "/all": NestedRouter,
    "/foo": this.post((req: TestRequest) => {
      return { foo: "foo" };
    }),
    "/products/:productId": this.put(ProductController, "update"),
  };
}
