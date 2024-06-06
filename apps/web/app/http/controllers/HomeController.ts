import { Controller } from "@/framework/Controller";

export class HomeController extends Controller {
  public async index() {
    return { message: "Hi" };
  }
}
