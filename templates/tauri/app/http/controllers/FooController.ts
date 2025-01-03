import { Query } from "gemi/facades";
import { Controller, HttpRequest, ResourceController } from "gemi/http";

export class FooController extends ResourceController {
  async index() {
    return {};
  }

  details(req: HttpRequest) {
    return {};
  }

  list(req: HttpRequest) {
    return [
      { id: "1", uuid: req.params.id },
      { id: "2", uuid: req.params.id },
    ];
  }

  show(req: HttpRequest) {
    return { id: req.params.fooBarBazId };
  }

  async create(req: HttpRequest<{ name: string; age: number }>) {
    const input = await req.input();
    console.log(input);
    return {};
  }

  update(req: HttpRequest) {
    return req.params;
  }

  delete() {}
}

export class TestController extends Controller {
  test() {}
}
