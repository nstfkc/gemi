import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { LogManager } from "./LogManager";
import { logConfigDefaults, type LogConfig } from "./config";

export class LogServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      LogManager,
      () =>
        new LogManager(
          withDefaults(
            logConfigDefaults(),
            this.app.config.get<LogConfig>("log", {}),
          ),
        ),
    );
  }

  /**
   * The log directory is created once at kernel boot rather than on the first
   * `Log.info()`, which is what the old eagerly-constructed container did.
   * Resolving here is deliberate: it is the one service whose readiness is a
   * boot-time side effect, and paying for it lazily mid-request would add file
   * IO to whichever handler happened to log first.
   */
  async boot() {
    await this.app.make(LogManager).boot();
  }
}
