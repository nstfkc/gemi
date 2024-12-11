import { ApiRouter } from "gemi/http";
import { FooController } from "../controllers/FooController";
import { FooApiRouter } from "./foo";

export class TestApiRouter extends ApiRouter {
  routes = {
    "/index": this.get(FooController, "index"),
    "/foo": FooApiRouter,
  };
}
