import { Controller, HttpRequest } from "gemi/http";

class CustomReq extends HttpRequest {}

export class HomeController extends Controller {
  public async foo(req: CustomReq) {
    return "Hello world";
  }
}
