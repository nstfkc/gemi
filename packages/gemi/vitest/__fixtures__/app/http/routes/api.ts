import { ApiRouter } from "../../../../../http/ApiRouter";
import type { HttpRequest } from "../../../../../http/HttpRequest";
import { PostController } from "../controllers/PostController";

export default class Api extends ApiRouter {
  routes = {
    // A type-only import of the request class, as an app writes it: the rewrite
    // has to turn it into a value import.
    "/search": this.get(async (req: HttpRequest<{ q: string }>) => {
      return { q: req.search.get("q") };
    }),
    "/posts/:id": this.get(PostController, "show"),
    "/posts/:id/rename": this.post(PostController, "rename"),
  };
}
