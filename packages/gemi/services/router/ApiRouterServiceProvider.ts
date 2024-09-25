import { createFlatApiRoutes, type FlatApiRoutes } from "./createFlatApiRoutes";
import type { ApiRouter } from "../../http/ApiRouter";
import { ServiceProvider } from "../ServiceProvider";
import { AuthApiRouter } from "../../auth/AuthenticationServiceProvider";
import { I18nRouter } from "../../http/I18nServiceContainer";

export class ApiRouterServiceProvider extends ServiceProvider {
  rootRouter: new () => ApiRouter;

  boot() {}
}
