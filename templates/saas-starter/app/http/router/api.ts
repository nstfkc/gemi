import { ApiRouter } from "gemi/http";
import { PostController } from "../controllers/PostController";

export default class extends ApiRouter {
  routes = {
    "/posts": this.resource(PostController),
  };
}
