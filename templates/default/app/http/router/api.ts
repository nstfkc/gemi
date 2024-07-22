import { ApiRouter, Controller, HttpRequest } from "gemi/http";
import { ResourceController } from "gemi/http/Controller";

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

class ProductController extends ResourceController {
  async update(req: HttpRequest<{ name: string }, { id: string }>) {
    const product = {} as Product;
    return { product };
  }
  async create(
    req: HttpRequest<{ id: string; name: string }, { name: string }>,
  ) {
    const product = {} as Product;
    return { product };
  }

  async list() {
    return { posts: [] };
  }
  async delete(req: HttpRequest<{}, { id: string }>) {}
  async show() {}
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
    "/products": this.resource(ProductController),
  };
}
