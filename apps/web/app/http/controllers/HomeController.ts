import { Controller } from "gemi/http";

export class HomeController extends Controller {
  public async index() {
    return { data: { count: 0 } };
  }
}
