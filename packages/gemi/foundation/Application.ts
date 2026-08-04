import { Container } from "../container/Container";
import { Repository } from "../support/Repository";
import type { ServiceProvider } from "../support/ServiceProvider";

export type ServiceProviderConstructor = new (
  app: Application,
) => ServiceProvider;

/**
 * Cross-copy brand. `dist/bin/gemi.js` bundles its own gemi while the app
 * resolves `gemi/*` to source, so `instanceof Application` is false for an
 * Application built by the other copy. `Symbol.for` is registry-global and
 * survives that boundary — the same reason services key off a `static token`
 * string rather than the constructor object.
 */
const APPLICATION_BRAND = Symbol.for("gemi.foundation.Application");

export class Application extends Container {
  readonly [APPLICATION_BRAND] = true;

  static isApplication(value: unknown): value is Application {
    return (
      typeof value === "object" && value !== null && APPLICATION_BRAND in value
    );
  }

  /**
   * Runtime configuration (`app/config/*.ts`). Also bound in the container, so
   * `app.make(Repository)` and `app.config` are the same object.
   */
  readonly config: Repository;

  private providers: ServiceProvider[] = [];
  private booted = false;

  constructor(config: Repository = new Repository()) {
    super();
    this.config = config;
    this.instance(Repository, config);
  }

  private static currentInstance: Application | undefined;

  static getInstance(): Application | undefined {
    return Application.currentInstance;
  }

  static setInstance(app: Application | undefined) {
    Application.currentInstance = app;
    return app;
  }

  /**
   * Instantiates the provider and runs its `register()` immediately, exactly as
   * Laravel does. Registration is therefore synchronous — only `boot()` is
   * async, which is what lets `new App({ kernel })` stay a sync constructor.
   */
  register(Provider: ServiceProviderConstructor): ServiceProvider {
    const existing = this.providers.find((p) => p instanceof Provider);
    if (existing) {
      return existing;
    }

    const provider = new Provider(this);
    provider.register();
    this.providers.push(provider);
    return provider;
  }

  registerMany(providers: ServiceProviderConstructor[]) {
    for (const Provider of providers) {
      this.register(Provider);
    }
  }

  getProviders(): ServiceProvider[] {
    return [...this.providers];
  }

  isBooted(): boolean {
    return this.booted;
  }

  /**
   * Phase two. Every provider has already registered by the time any of these
   * run, so a provider's `boot()` may resolve services owned by any other.
   */
  async boot(): Promise<void> {
    if (this.booted) {
      return;
    }
    for (const provider of this.providers) {
      await provider.boot();
    }
    this.booted = true;
  }

  flush() {
    super.flush();
    this.instance(Repository, this.config);
    this.providers = [];
    this.booted = false;
  }
}
