import { ServiceProvider } from "../support/ServiceProvider";
import { checkAuthFlowSwitches, type AuthConfig } from "./config";
import { AuthManager } from "./AuthManager";
import { checkFixedSignInCode } from "./fixedCode";
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

  /**
   * A misspelt route switch fails the boot, not the first sign-in, and so does
   * a fixed sign-in code in production (#1190).
   */
  boot() {
    const config = this.app.config.get<AuthConfig>("auth", {});
    checkAuthFlowSwitches(config);
    checkFixedSignInCode(config?.emailCode?.fixedCode);
  }
}
