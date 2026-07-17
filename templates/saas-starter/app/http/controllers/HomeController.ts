import { Controller } from "gemi/http";

export class HomeController extends Controller {
  async index() {
    return {
      message: "Hello from HomeController 1",
    };
  }
}
