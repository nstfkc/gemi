import { Controller, HttpRequest } from "gemi/http";

export class HomeController extends Controller {
  async foo(req: HttpRequest) {
    return "Hello world";
  }
}

class TestController extends Controller {
  public async foo(req: HttpRequest) {
    return "Hello world";
  }

  private async bar(req: HttpRequest) {
    return "Hello world";
  }
}
