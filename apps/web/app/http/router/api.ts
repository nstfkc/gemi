import { ApiRouter, Controller, HttpRequest } from "gemi/http";

class TestRequest extends HttpRequest<{ name: string }> {
  schema = {
    name: {
      required: "Name is required",
    },
  };
}

class TestController extends Controller {
  requests = {
    test: TestRequest,
  };

  async test(req: TestRequest) {
    const input = await req.input();
    const { name } = input.toJSON();
    return { data: { message: `Hello, ${name}!` } };
  }
}

export default class extends ApiRouter {
  routes = {
    "/test": this.post(TestController, "test"),
  };
}
