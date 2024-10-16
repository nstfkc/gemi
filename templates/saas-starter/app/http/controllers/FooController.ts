import { Query } from "gemi/facades";
import { HttpRequest, ResourceController } from "gemi/http";

export class FooController extends ResourceController {
  async index() {
    const x = await Query.instant("/foo/:fooId", { params: { fooId: "1234" } });
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
    return { id: "ENES" };
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
