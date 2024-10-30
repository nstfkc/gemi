import { HttpRequest } from "../../http";
import type { ApiRouter } from "../../http/ApiRouter";
import { ServiceProvider } from "../ServiceProvider";

export class ApiRouterServiceProvider extends ServiceProvider {
  rootRouter: new () => ApiRouter;

  boot() {
    return "Origin";
  }

  onRequestStart(_req: HttpRequest): void | Promise<void> {}
  onRequestEnd(_req: HttpRequest): void | Promise<void> {}
  onRequestFail(_req: HttpRequest, error: any): void | Promise<void> {}
}
