import type { Application } from "../foundation/Application";

/**
 * Both hooks default to no-ops. `register()` binds services into the container
 * and must not resolve any of them; `boot()` runs after every provider has
 * registered, so it may resolve freely.
 */
export abstract class ServiceProvider {
  constructor(protected app: Application) {}

  register(): void {}

  boot(): void | Promise<void> {}
}
