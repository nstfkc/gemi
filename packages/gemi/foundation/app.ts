import type { ServiceToken } from "../container/Container";
import { kernelContext } from "../kernel/context";
import { Application } from "./Application";

/**
 * Resolves the Application for the current async context. Reads the kernel
 * AsyncLocalStorage — there is exactly one ALS in the framework, and
 * `Kernel.run()` stores the Application in it, so this is the primary path for
 * anything running inside a request, a websocket message or a cron tick.
 *
 * The static instance (Laravel's `Container::setInstance`, set by
 * `Kernel.boot()`) is the fallback for code that runs outside any `run()`
 * scope — build-time tooling, module top level, a stray `setTimeout`.
 */
export function app(): Application;
export function app<T>(token: ServiceToken<T>): T;
export function app<T>(token?: ServiceToken<T>): Application | T {
  const store = kernelContext.getStore();
  const instance = Application.isApplication(store)
    ? store
    : Application.getInstance();

  if (!instance) {
    throw new Error(
      "No Application instance is available. Boot a Kernel before resolving services.",
    );
  }

  return token ? instance.make(token) : instance;
}
