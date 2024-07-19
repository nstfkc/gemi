import { ApiRouter, HttpRequest } from "gemi/http";

class TestRequest extends HttpRequest<{ id: string }> {
  schema = {
    id: {},
  };
}

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

class TestRouter extends ApiRouter {
  routes = {
    "/all": NestedRouter,
    "/foo": this.post(async (req: TestRequest) => {
      const input = await req.input();
      input.get("id");
      return { foo: "foo" };
    }),
  };
}
