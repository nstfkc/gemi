import { ApiRouterServiceProvider } from "gemi/services";
import RootApiRouter from "../http/router/api";
import type { HttpRequest } from "gemi/http";

export default class extends ApiRouterServiceProvider {
  override rootRouter = RootApiRouter;

  boot() {
    return "test";
  }

  onRequestStart(req: HttpRequest) {
    console.time("API");
    console.log(`Api start ${req.rawRequest.url}`);
  }

  onRequestEnd(req: HttpRequest) {
    console.timeEnd("API");
    console.log(`Api end ${req.rawRequest.url}`);
  }
}
