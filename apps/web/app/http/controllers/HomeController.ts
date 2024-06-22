import { Controller } from "gemi/http";

export class HomeController extends Controller {
  public async index() {
    return { data: { count: 0 } };
  }

  public async foo() {
    return { data: { message: "This is foo" } };
  }

  public async bar() {
    return { data: { message: "This is bar" } };
  }
}
