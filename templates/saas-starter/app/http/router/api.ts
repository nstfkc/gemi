import { ApiRouter, HttpRequest } from "gemi/http";
import { PostController } from "../controllers/PostController";

export default class extends ApiRouter {
  routes = {
    "/posts": this.resource(PostController),
    "/test": this.get((req: HttpRequest) => {
      req.ctx.setCookie({ name: "foo", value: "bar" });
      return { message: "Hello" };
    }),
  };
}
