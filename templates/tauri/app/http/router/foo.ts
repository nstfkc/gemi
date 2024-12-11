import { ApiRouter } from "gemi/http";
import { FooController } from "../controllers/FooController";

export class FooApiRouter extends ApiRouter {
  routes = {
    "/details": this.get(FooController, "details"),
  };
}
