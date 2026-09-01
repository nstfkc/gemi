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
   *
   * Only for a process that is serving, though. `runConsole` boots these same
   * providers for every command, as does a migration or a test with a Kernel,
   * and preparing a log file is not free: a `mkdir`, a `readdir`, and — when
   * the newest file still has room — reading its whole text back into a fresh
   * writer, up to `maxFileSize` (10MB by default), in whatever directory the
   * process was started from. `ROOT_DIR` is what `Server.start` sets and
   * nothing else does. Those contexts stay lazy rather than silent: a command
   * that actually logs still gets its file, because `LogManager.log()` boots
   * the manager on first use.
   */
  async boot() {
    if (!process.env.ROOT_DIR) {
      return;
    }
    await this.app.make(LogManager).boot();
  }
}
