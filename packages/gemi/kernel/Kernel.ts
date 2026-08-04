import { Application } from "../foundation/Application";
import type { ServiceProviderConstructor } from "../foundation/Application";
import type { ServiceToken } from "../container/Container";
import type { ConfigItems } from "../support/Repository";
import { registerModels } from "../orm/registration";
import { registeredNames } from "../orm/registry";
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

  /**
   * The modules holding the app's model classes — normally
   * `[generated, models]`, the generated namespace and the barrel of subclasses
   * written over it. Every model class they export is registered under the name
   * its schema carries, later modules winning, and the whole set is audited
   * before anything else boots.
   *
   * ### Why this is a Kernel field and not a line in a file somewhere
   *
   * Registration used to be `register("User", User)` next to each subclass, and
   * the failure mode of forgetting it is an authorization hole that nothing
   * reports: a relation read resolves its target by name, so an unregistered
   * policied subclass leaves the generated base owning the name and every
   * nested `include` of that model comes back unscoped. No error at the root
   * either, because `$exec`'s divergence guard begins `registered !== this` and
   * the base it is running on *is* the registered one. A model only ever read
   * through an include — a membership, a pivot, the kind that carries a tenant
   * scope — never trips anything.
   *
   * Listing the modules here says it once, in the same place the app already
   * declares its config slices and providers, and turns the mistake into a
   * failure to boot rather than a quiet cross-tenant read.
   *
   * It sees the modules it is given, so a model class in a file that no barrel
   * re-exports is still invisible. That is the residual, and it is a smaller
   * one: a barrel is a place to notice an omission, and thirteen `register`
   * lines scattered across thirteen files is not.
   */
  protected models: Array<Record<string, unknown>> = [];

  readonly app = new Application();

  /**
   * Phase one, synchronous: every provider is constructed and its `register()`
   * runs. Only bindings are recorded here — no service is instantiated, so this
   * is safe to call from a synchronous constructor (`new App({ kernel })`).
   * Phase two is `waitForBoot()`.
   */
  boot() {
    // Before the container, deliberately. This throws on a model whose policies
    // would be skipped, and the useful moment for that is the one where nothing
    // has been constructed and no request can be in flight.
    if (this.models.length > 0) registerModels(...this.models);
    else warnIfModelsAreRegisteredButUndeclared();

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

/**
 * Says something to an application that has models and has not declared them.
 *
 * Without this the fix for #316 defaults to off. `models` is `[]`, `boot()`
 * no-ops, and an app upgrading from 0.48 is in exactly the state the issue
 * describes until somebody edits their Kernel by hand — while the only place
 * that says to is the **Setup** section of `docs/orm.md`, which an existing app
 * read once and will not read again. #316 was filed by an app mid-migration
 * with a 79-model schema, which is precisely the reader who never sees it.
 *
 * The condition is what makes this worth printing. A populated registry with an
 * empty `models` means the generated `index.ts` was imported and its bases are
 * what every nested read resolves to — so if any policy lives on a subclass, it
 * is being skipped inside includes right now. A Kernel with no ORM at all has
 * an empty registry and hears nothing.
 *
 * Development only, and a warning rather than a throw: an app in this state is
 * running today, and turning a working deploy into a failure to start over an
 * arrangement that *might* be fine is not a patch-level thing to do. The
 * failure it points at is silent, so the fix for it has to be noisy somewhere,
 * and the terminal an author is already looking at is the cheapest somewhere
 * there is.
 */
function warnIfModelsAreRegisteredButUndeclared(): void {
  if (process.env.NODE_ENV === "production") return;

  const registered = registeredNames();
  if (registered.length === 0) return;

  console.warn(
    `[gemi] ${registered.length} model${registered.length === 1 ? " is" : "s are"} ` +
      `registered, but Kernel.models is empty.\n` +
      `        Nested relation reads resolve a model by name, so a policy on a ` +
      `subclass that does not own its\n` +
      `        name is skipped inside every include — scoped at the root, ` +
      `unscoped in an include, with nothing\n` +
      `        to notice it. Declaring the modules registers each class under ` +
      `its own name and audits the set:\n\n` +
      `            import * as generated from "../models/generated"\n` +
      `            import * as models from "../models"\n\n` +
      `            export default class extends Kernel {\n` +
      `              models = [generated, models]\n` +
      `            }\n\n` +
      `        See docs/orm.md#your-model-class. Development only; this never ` +
      `prints in production.`,
  );
}
