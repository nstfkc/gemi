import { Controller } from "gemi/http";

export class HomeController extends Controller {
  public async index() {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    return { message: "Hello world!" };
  }
}
