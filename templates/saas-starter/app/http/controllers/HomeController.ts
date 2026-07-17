import { Controller, HttpRequest } from "gemi/http";

class CustomHttpRequest extends HttpRequest {
  schema = {
    name: {
      required: "Name is required",
    },
    email: {
      required: "Email is required",
      email: "Email must be valid",
    },
  };
}

export class HomeController extends Controller {
  async index() {
    return {
      message: "Hello from HomeController 1",
    };
  }

  async post(req: CustomHttpRequest) {
    const input = await req.input();
    const data = input.toJSON();
    return {
      data,
    };
  }
}
