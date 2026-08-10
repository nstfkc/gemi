import type { ServiceToken } from "../container/Container";
import { app } from "../foundation/app";

/**
 * Base for the application's own long-lived singletons — an API client, a
 * billing gateway, a search index. A subclass declares a `static token`, holds
 * its settings as ordinary fields, and is listed in `services` on the Kernel;
 * the kernel constructs it once and awaits its `boot()` before the first
 * request is served.
 *
 * ### Why the settings are fields and not a config slice
 *
 * `app/config/*.ts` exists because you do not own the class. `MailManager` and
 * `AuthManager` ship with the framework, so a config slice is the only place
 * you can reach in and change them. You *do* own a `Service` subclass, so there
 * is nothing to reach in from the outside for — a field is a real declaration
 * the compiler checks, where a config slice is a string key and a cast over
 * `Repository.get`, which returns `any`. Use `.with()` to override at the
 * wiring site or in a test.
 *
 * ### Why `boot()` is async and the constructor is not
 *
 * `Container.make` is synchronous, so a lazily-constructed service could never
 * await anything. Construction therefore does no I/O — it runs during the
 * kernel's synchronous phase, which is what makes an instance available to a
 * provider's `boot()` — and everything that needs to await happens in `boot()`,
 * during the asynchronous phase. The cost is that every listed service is
 * constructed and booted on every application boot, including in a worker
 * thread and in every test that boots a kernel. Keep `boot()` cheap: validate
 * settings there, and open connections lazily inside the methods that need
 * them.
 */
export abstract class Service {
  /**
   * The container key. Required, and a string literal rather than the class's
   * implicit `.name`, for the same reason every other service in the framework
   * carries one — see the note on `ServiceToken`. Minification renames the
   * class; it cannot rename a string.
   */
  static token: string;

  /**
   * Awaited once during kernel boot, in `services` order. A service whose
   * `boot()` needs another service must be listed after it.
   */
  async boot(): Promise<void> {}

  /**
   * The booted singleton for the current application.
   *
   * Written as a constructor default so a controller reads as an ordinary
   * class and stays constructible by hand:
   *
   *   class FooController extends Controller {
   *     constructor(private billing = Billing.inject()) {
   *       super();
   *     }
   *   }
   *
   * The default is evaluated when the controller is constructed — per request,
   * inside the kernel's async context — so this resolves against the
   * Application handling that request, and a test that passes its own instance
   * never evaluates it at all.
   */
  static inject<T>(
    this: (abstract new (...args: any[]) => T) & {
      token: string;
      name: string;
    },
  ): T {
    if (!this.token) {
      throw new Error(
        `Service [${this.name}] does not declare a \`static token\`, so the container has no key to resolve it by.`,
      );
    }

    try {
      return app(this as ServiceToken<T>);
    } catch (cause) {
      throw new Error(
        `Could not inject [${this.name}]. Services are constructed when the kernel boots, so ` +
          `inject() only works from code that runs after that — a constructor default or a method ` +
          `body, never module top level. Check that [${this.name}] is listed in \`services\` on ` +
          `your Kernel.`,
        { cause },
      );
    }
  }

  /**
   * A configured instance: constructs the service and assigns over its fields.
   * Typed against the subclass, which a constructor parameter on this base
   * class could not be — there is no `Partial<this>` in a constructor
   * signature.
   *
   *   services = [Billing.with({ apiKey: process.env.STAGING_KEY })];
   *   const billing = Billing.with({ apiKey: "test" }); // in a test
   */
  static with<T extends Service>(this: new () => T, overrides: Partial<T>): T {
    return Object.assign(new this(), overrides);
  }
}

/**
 * A `Service` subclass, as the Kernel's `services` array accepts it. The array
 * also takes instances, which is what `.with()` returns.
 */
export type ServiceConstructor = (new () => Service) & {
  token: string;
  name: string;
};
