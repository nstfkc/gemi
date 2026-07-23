import { ServiceProvider } from "../../support/ServiceProvider";
import { ApiRouteDispatcher } from "./ApiRouteDispatcher";
import { ViewRouteDispatcher } from "./ViewRouteDispatcher";
import type { ApiRouteConfig, ViewRouteConfig } from "./config";
import type { Repository } from "../../support/Repository";

function readConfig<T>(config: Repository, key: string): T {
  const slice = config.get<T>(key);
  if (!slice) {
    throw new Error(
      `Missing "${key}" configuration. Route dispatching needs a root router — declare it in "app/config/route.ts".`,
    );
  }
  return slice;
}

/**
 * Owns both route dispatchers. Laravel ships a single RouteServiceProvider for
 * every route file it loads; the api/view split is a config slice, not a
 * separate provider.
 */
export class RouteServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      ApiRouteDispatcher,
      () =>
        new ApiRouteDispatcher(
          readConfig<ApiRouteConfig>(this.app.config, "route.api"),
        ),
    );

    this.app.singleton(
      ViewRouteDispatcher,
      () =>
        new ViewRouteDispatcher(
          readConfig<ViewRouteConfig>(this.app.config, "route.view"),
        ),
    );
  }

  /**
   * The two dispatchers are the one pair of services that must not be built
   * lazily: constructing them flattens the route tables and runs
   * `assertNoReservedRoutePaths`, so a missing `route` config or a route under
   * a reserved prefix has to fail the boot rather than the first request that
   * happens to hit it.
   */
  boot() {
    this.app.make(ApiRouteDispatcher);
    this.app.make(ViewRouteDispatcher);
  }
}
