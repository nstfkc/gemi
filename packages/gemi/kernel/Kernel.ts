import { Application } from "../foundation/Application";
import type { ServiceProviderConstructor } from "../foundation/Application";
import type { ServiceToken } from "../container/Container";
import type { ConfigItems } from "../support/Repository";
import { Scheduler } from "../services/cron/Scheduler";
import { BroadcastManager } from "../services/pubsub/BroadcastManager";
import { QueueManager } from "../services/queue/QueueManager";
import { ApiRouteDispatcher } from "../services/router/ApiRouteDispatcher";
import { ViewRouteDispatcher } from "../services/router/ViewRouteDispatcher";
import { kernelContext } from "./context";
import { frameworkProviders } from "./providers";

/**
 * The app's entry point into the framework. A Kernel subclass declares what the
 * app adds — its `config` slices and any extra `providers` — and everything
 * else lives in the Application container it owns.
 */
export class Kernel {
  /**
   * App-level config, merged over the framework defaults. Each key is a config
   * slice: `{ mail: { ... }, route: { ... } }`, normally the modules under
   * `app/config`.
   */
  protected config: ConfigItems = {};

  /**
   * App-level providers, registered after the framework's own so they can
   * rebind anything the framework bound.
   */
  protected providers: ServiceProviderConstructor[] = [];

  readonly app = new Application();

  /**
   * Phase one, synchronous: every provider is constructed and its `register()`
   * runs. Only bindings are recorded here — no service is instantiated, so this
   * is safe to call from a synchronous constructor (`new App({ kernel })`).
   * Phase two is `waitForBoot()`.
   */
  boot() {
    this.app.config.merge(this.config);
    Application.setInstance(this.app);
    this.app.registerMany([...frameworkProviders, ...this.providers]);
  }

  /**
   * Phase two, asynchronous: every provider's `boot()` runs, in registration
   * order, after all of them have registered. Idempotent.
   */
  async waitForBoot() {
    await this.app.boot();
  }

  run<T>(cb: () => T) {
    return kernelContext.run(this.app, cb);
  }

  /**
   * Resolve a service by token. Callers outside this module should prefer the
   * named accessors below or `app()`; this exists for tooling that holds a
   * Kernel but no ambient context.
   */
  resolve<T>(token: ServiceToken<T>): T {
    return this.app.make(token);
  }

  // Named accessors. `app/App.ts` goes through these rather than importing the
  // service classes itself — see the note in that file about the two copies of
  // gemi that coexist at build time.
  apiRoutes(): ApiRouteDispatcher {
    return this.app.make(ApiRouteDispatcher);
  }

  viewRoutes(): ViewRouteDispatcher {
    return this.app.make(ViewRouteDispatcher);
  }

  broadcast(): BroadcastManager {
    return this.app.make(BroadcastManager);
  }

  queue(): QueueManager {
    return this.app.make(QueueManager);
  }

  destroy() {
    // Only touch services that were actually resolved — resolving one here
    // would construct it purely to tear it down.
    if (this.app.resolved(Scheduler)) {
      this.app.make(Scheduler).stop();
    }

    this.app.flush();

    if (Application.getInstance() === this.app) {
      Application.setInstance(undefined);
    }

    kernelContext.disable();
  }
}
