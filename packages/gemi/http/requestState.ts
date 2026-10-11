/**
 * Typed values kept for the length of one request (#887): what a middleware
 * resolved, handed to the controller, or what an agent turn's `context()`
 * decided, handed to its `onMessage`.
 *
 * ```ts
 * export const pageScope = stateKey<PageScope>("pageScope");
 *
 * // middleware
 * this.req.state.set(pageScope, await resolvePageScope(this.req.params.pageId));
 *
 * // controller
 * const scope = req.state.require(pageScope);
 * ```
 *
 * WHY KEYS, NOT A DECLARATION-MERGED INTERFACE. A key compares by identity, so
 * it stays private to the module that made it and two modules choosing the
 * same name cannot collide; and a read that must find a value (`require`)
 * comes back as `T`, where every field of an app-wide interface would have to
 * be optional. The name is for error messages only.
 *
 * WHY ON THE REQUEST, NOT THE CONTEXT STORE. Every `HttpRequest` built for a
 * request — the router's, a middleware's, `req = new HttpRequest()` in a
 * handler, a custom request class — shares one `RequestState`, so it reads the
 * same wherever it is reached from. Held by those objects rather than by the
 * store, it is still readable after the store is destroyed, by a hook that
 * runs as a streamed body ends.
 */
export interface StateKey<T> {
  readonly name: string;
  /** Type-only: carries `T`. Never set. */
  readonly __type?: T;
}

export function stateKey<T>(name: string): StateKey<T> {
  return Object.freeze({ name });
}

/** `req.state.require(key)` found nothing: the code that sets it did not run. */
export class MissingRequestStateError extends Error {
  constructor(public readonly key: StateKey<unknown>) {
    super(
      `Request state "${key.name}" is not set. ` +
        "Check that whatever sets it (a middleware, `context()`) ran for this request.",
    );
    this.name = "MissingRequestStateError";
  }
}

export class RequestState {
  #values = new Map<StateKey<unknown>, unknown>();

  /** The value, or `undefined` when nothing set it for this request. */
  get<T>(key: StateKey<T>): T | undefined {
    return this.#values.get(key) as T | undefined;
  }

  /** The value; throws `MissingRequestStateError` when nothing set it. */
  require<T>(key: StateKey<T>): T {
    if (!this.#values.has(key)) {
      throw new MissingRequestStateError(key);
    }
    return this.#values.get(key) as T;
  }

  /** Sets the value for the rest of this request and returns it. */
  set<T>(key: StateKey<T>, value: NoInfer<T>): T {
    this.#values.set(key, value);
    return value;
  }

  has(key: StateKey<any>): boolean {
    return this.#values.has(key);
  }

  delete(key: StateKey<any>): boolean {
    return this.#values.delete(key);
  }

  /**
   * Internal: copies what the global middleware list set into the route's
   * request (see `RequestContext.run`). A key the route already holds keeps
   * its own value.
   */
  static carry(from: RequestState, to: RequestState) {
    for (const [key, value] of from.#values) {
      if (!to.#values.has(key)) {
        to.#values.set(key, value);
      }
    }
  }
}
