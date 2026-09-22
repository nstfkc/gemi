import type { Application } from "../foundation/Application";

/**
 * Every hook defaults to a no-op. `register()` binds services into the
 * container and must not resolve any of them; `boot()` runs after every
 * provider has registered, so it may resolve freely.
 *
 * `shutdown()` runs once when a production server is told to stop (`SIGTERM`
 * or `SIGINT`), after it has stopped accepting requests and the in-flight ones
 * have finished or run out of grace — so nothing a request needs is torn down
 * under it. Providers shut down in reverse registration order, so one
 * registered after another may still use it. Each is awaited, but under a
 * shared deadline (`GEMI_SHUTDOWN_PROVIDER_TIMEOUT`): one that overruns is
 * abandoned and the next begins, and one that throws is logged and does not
 * stop the rest. See `Application.shutdown`.
 */
export abstract class ServiceProvider {
  constructor(protected app: Application) {}

  register(): void {}

  boot(): void | Promise<void> {}

  shutdown(): void | Promise<void> {}
}
