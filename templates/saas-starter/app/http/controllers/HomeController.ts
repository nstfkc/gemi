import { Controller } from "gemi/http";

export class HomeController extends Controller {
  public async index() {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return { message: "Hello world!" };
  }
}
