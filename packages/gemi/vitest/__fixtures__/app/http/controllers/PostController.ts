import { Controller } from "../../../../../http/Controller";
import { HttpRequest } from "../../../../../http/HttpRequest";

class RenameRequest extends HttpRequest<{ title: string }, { id: string }> {
  schema = {
    title: { required: "Title is required" },
  };
}

// Written the way an app writes a controller: the request is a typed parameter,
// not a default value. Only the request-param rewrite makes `req` defined.
export class PostController extends Controller {
  async show(req: HttpRequest<{}, { id: string }>) {
    return { id: req.params.id };
  }

  async rename(req: RenameRequest) {
    const input = await req.input();
    return { id: req.params.id, title: input.get("title") };
  }
}
