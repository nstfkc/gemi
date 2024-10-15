import { Query } from "gemi/facades";
import { HttpRequest, ResourceController } from "gemi/http";

export class FooController extends ResourceController {
  index() {
    Query.prefetch("/foo/:id", { params: { id: "Enes" } });
    return {};
  }
  details(req: HttpRequest) {
    Query.prefetch("/foo/:id", { params: req.params });
    return {};
  }

  list(req: HttpRequest) {
    return [
      { id: "1", uuid: req.params.id },
      { id: "2", uuid: req.params.id },
    ];
  }
  show(req: HttpRequest) {
    return { id: req.params.id };
  }
  create() {}
  update(req: HttpRequest) {
    return req.params;
  }
  delete() {}
}
