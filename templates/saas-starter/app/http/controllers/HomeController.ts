import { Controller } from "gemi/http";

export class HomeController extends Controller {
  public async index() {
    return { message: "Hello world!" };
  }
}
