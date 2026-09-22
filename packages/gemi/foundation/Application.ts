import { Container } from "../container/Container";
import { Repository } from "../support/Repository";
import type { ServiceProvider } from "../support/ServiceProvider";

export type ServiceProviderConstructor = new (
  app: Application,
) => ServiceProvider;

/**
 * What `Application.shutdown()` could not finish, by provider class name. Both
 * empty means every provider's `shutdown()` resolved in time.
 */
export type ShutdownReport = { failed: string[]; timedOut: string[] };

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

  /**
   * Runs every provider's `shutdown()`, in reverse registration order, and
   * resolves with what did not finish cleanly. Never rejects: this runs on the
   * way out of a process, and a throw here would skip the providers after the
   * one that threw — the database pool closing is exactly the kind of thing
   * that must not depend on the mail provider behaving.
   *
   * Reverse order because registration order is dependency order: a provider
   * registered later may use an earlier one in its own `shutdown()` (the
   * queue finishing its jobs against a database that is still open).
   *
   * The providers share one deadline rather than each getting `timeoutMs`,
   * because the caller's budget is a platform's grace period, which bounds the
   * whole exit — seventeen providers each allowed five seconds would add up to
   * a `SIGKILL`. A provider that overruns is abandoned (its promise keeps
   * running; the process is about to exit) and reported in `timedOut`; one
   * reached after the deadline has passed is not called at all and reported
   * the same way.
   *
   * Idempotent: a second call returns the first call's result.
   */
  shutdown(options: { timeoutMs?: number } = {}): Promise<ShutdownReport> {
    this.shutdownPromise ??= this.shutdownProviders(options.timeoutMs ?? 5_000);
    return this.shutdownPromise;
  }

  private shutdownPromise: Promise<ShutdownReport> | undefined;

  private async shutdownProviders(timeoutMs: number): Promise<ShutdownReport> {
    const report: ShutdownReport = { failed: [], timedOut: [] };
    const deadline = Date.now() + timeoutMs;

    for (const provider of [...this.providers].reverse()) {
      const name = provider.constructor.name;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.error(
          `[gemi] ${name}.shutdown() skipped: the provider shutdown deadline had passed.`,
        );
        report.timedOut.push(name);
        continue;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        // `.then` rather than a direct call, so a synchronous throw lands in
        // the same `catch` as a rejection.
        Promise.resolve()
          .then(() => provider.shutdown())
          .then(
            () => "done" as const,
            (error: unknown) => {
              console.error(`[gemi] ${name}.shutdown() failed:`, error);
              return "failed" as const;
            },
          ),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]);
      clearTimeout(timer);

      if (outcome === "failed") report.failed.push(name);
      if (outcome === "timeout") {
        console.error(
          `[gemi] ${name}.shutdown() did not finish within the provider shutdown deadline; moving on.`,
        );
        report.timedOut.push(name);
      }
    }

    return report;
  }

  flush() {
    super.flush();
    this.instance(Repository, this.config);
    this.providers = [];
    this.booted = false;
    this.shutdownPromise = undefined;
  }
}
