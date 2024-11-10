import { ApiRouterServiceProvider } from "gemi/services";
import RootApiRouter from "../http/router/api";
import type { HttpRequest } from "gemi/http";

export default class extends ApiRouterServiceProvider {
  override rootRouter = RootApiRouter;

  boot() {
    return "test";
  }

  onRequestStart(req: HttpRequest) {}

  onRequestEnd(req: HttpRequest) {}
}
