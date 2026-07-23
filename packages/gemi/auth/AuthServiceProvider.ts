import { ServiceProvider } from "../support/ServiceProvider";
import type { AuthConfig } from "./config";
import { AuthManager } from "./AuthManager";

export class AuthServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      AuthManager,
      () => new AuthManager(this.app.config.get<AuthConfig>("auth", {})),
    );
  }
}
