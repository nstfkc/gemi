import { Controller } from "gemi/http";

export class HomeController extends Controller {
  public async index() {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { message: "Hello world!" };
  }
}
