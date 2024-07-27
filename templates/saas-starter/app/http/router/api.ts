import { ApiRouter, HttpRequest } from "gemi/http";
import { PostController } from "../controllers/PostController";
import { Temporal } from "temporal-polyfill";

export default class extends ApiRouter {
  routes = {
    "/posts": this.resource(PostController),
    "/test": this.get((req: HttpRequest) => {
      const x = Temporal.Now.instant().until(
        Temporal.Instant.from("2024-07-27T12:38:40.426Z"),
      ).sign;
      return { message: x, instant: Temporal.Now.instant() };
    }),
  };
}
