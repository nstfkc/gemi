import type { ApiRouter } from "../../http/ApiRouter";
import { ServiceProvider } from "../ServiceProvider";

export class ApiRouterServiceProvider extends ServiceProvider {
  rootRouter: new () => ApiRouter;

  boot() {
    return "Origin";
  }
}
