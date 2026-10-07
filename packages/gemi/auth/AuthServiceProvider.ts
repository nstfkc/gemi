import { ServiceProvider } from "../support/ServiceProvider";
import type { AuthConfig } from "./config";
import { AuthManager } from "./AuthManager";
import { ConnectionManager } from "./connections/ConnectionManager";

export class AuthServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      AuthManager,
      () => new AuthManager(this.app.config.get<AuthConfig>("auth", {})),
    );
    this.app.singleton(ConnectionManager, () => {
      const config = this.app.config.get<AuthConfig>("auth", {});
      return new ConnectionManager({
        providers: config.connections ?? {},
        store: config.connectionStore ?? undefined,
      });
    });
  }
}
