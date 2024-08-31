import { createFlatApiRoutes, type FlatApiRoutes } from "./createFlatApiRoutes";
import type { ApiRoutes } from "../../http/ApiRouter";
import { ServiceProvider } from "../ServiceProvider";

export class ApiRouterServiceProvider extends ServiceProvider {
  flatRoutes: FlatApiRoutes = {};
  boot(routes: ApiRoutes) {
    this.flatRoutes = createFlatApiRoutes(routes);
  }
}
