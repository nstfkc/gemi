import {
  middlewareConfigDefaults,
  type MiddlewareConfig,
} from "../../http/middleware-config";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { MiddlewareRegistry } from "./MiddlewareRegistry";

export class MiddlewareServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      MiddlewareRegistry,
      () =>
        new MiddlewareRegistry(
          withDefaults(
            middlewareConfigDefaults(),
            this.app.config.get<MiddlewareConfig>("middleware", {}),
          ),
        ),
    );
  }
}
