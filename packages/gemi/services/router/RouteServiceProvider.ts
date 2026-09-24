import { ServiceProvider } from "../../support/ServiceProvider";
import { McpRegistry } from "../mcp/McpRegistry";
import { ApiRouteDispatcher } from "./ApiRouteDispatcher";
import { DomainRouter } from "./DomainRouter";
import { ViewRouteDispatcher } from "./ViewRouteDispatcher";
import type { ApiRouteConfig, DomainsConfig, McpRouteConfig, ViewRouteConfig } from "./config";
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

    // The root pair above is the root group's; the other `route.domains`
    // groups get their own only when they bring their own routers.
    this.app.singleton(
      DomainRouter,
      () =>
        new DomainRouter(
          { api: this.app.make(ApiRouteDispatcher), view: this.app.make(ViewRouteDispatcher) },
          {
            api: readConfig<ApiRouteConfig>(this.app.config, "route.api"),
            view: readConfig<ViewRouteConfig>(this.app.config, "route.view"),
            domains: this.app.config.get<DomainsConfig | undefined>("route.domains"),
          },
        ),
    );

    // Bound whether or not the app declares one, so asking for it without
    // `route.mcp` fails with a sentence rather than an unbound token.
    this.app.singleton(McpRegistry, () => {
      const config = this.app.config.get<McpRouteConfig | undefined>("route.mcp");
      if (!config?.router) {
        throw new Error(
          'No MCP router is configured. Declare one as `mcp: { router }` in "app/config/route.ts".',
        );
      }
      return new McpRegistry(new config.router(), this.app.make(ApiRouteDispatcher));
    });
  }

  /**
   * The dispatchers of every host group, and the MCP registry when an app declares one, must
   * not be built lazily: constructing the dispatchers flattens the route
   * tables and runs `assertNoReservedRoutePaths`, and constructing the registry
   * resolves every tool against those tables. A missing `route` config, a
   * route under a reserved prefix or a tool naming a route that is gone has to
   * fail the boot rather than the first request, or the first tool call, that
   * happens to hit it.
   */
  boot() {
    this.app.make(ApiRouteDispatcher);
    this.app.make(ViewRouteDispatcher);
    // Builds every host group's dispatchers and validates `route.domains`.
    this.app.make(DomainRouter);
    if (this.app.config.get("route.mcp")) {
      this.app.make(McpRegistry);
    }
  }
}
