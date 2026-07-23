import type { ServiceToken } from "../container/Container";
import { app } from "../foundation/app";

/**
 * Base for the facades that front a container binding. A subclass names the
 * service it proxies with `getFacadeAccessor()` and reaches the live instance
 * through `this.getFacadeRoot()`, so the binding is resolved per call against
 * the Application for the current async context — never captured at module
 * load, which is what makes a facade swappable in tests.
 *
 * Two deliberate divergences from `Illuminate\Support\Facades\Facade`:
 *
 * 1. No `__callStatic`. TypeScript has no typed equivalent, and a Proxy would
 *    erase the very signatures that make these facades worth having. Subclasses
 *    therefore declare explicit statics that forward to `getFacadeRoot()`.
 *
 * 2. `getFacadeAccessor()` is public, not protected. `getFacadeRoot()` types
 *    its `this` structurally in order to infer the service type from the
 *    accessor's return, and a protected static is not structurally assignable
 *    to that.
 *
 * Facades that resolve nothing from the container — Cookie, Redirect, Url,
 * Meta — do not extend this class.
 */
export abstract class Facade {
  static getFacadeAccessor(): ServiceToken<any> {
    throw new Error(
      `Facade [${this.name}] does not implement getFacadeAccessor().`,
    );
  }

  static getFacadeRoot<T>(this: {
    getFacadeAccessor(): ServiceToken<T>;
  }): T {
    return app(this.getFacadeAccessor());
  }
}
