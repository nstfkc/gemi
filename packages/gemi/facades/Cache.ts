import { CacheManager, type CacheTtl, type TaggedCache } from "../services/cache/CacheManager";
import { Facade } from "./Facade";

/**
 * The application's cache, configured by `app/config/cache.ts`: in this
 * process's memory by default, in Redis with `store: "redis"`.
 *
 * ```ts
 * const plan = await Cache.remember(`plan:${hash}`, "24h", () => planner.plan(input));
 *
 * await Cache.tags(`user:${user.id}`).set(`billing:${user.id}`, billing, "5m");
 * await Cache.tags(`user:${user.id}`).flush();
 * ```
 *
 * Values are JSON-encoded on every store. See `docs/cache.md`.
 */
export class Cache extends Facade {
  static getFacadeAccessor() {
    return CacheManager;
  }

  /** The value under `key`, or `undefined` on a miss. */
  static get<T = unknown>(key: string): Promise<T | undefined> {
    return this.getFacadeRoot().get<T>(key);
  }

  /** Whether a value is stored under `key`. */
  static has(key: string): Promise<boolean> {
    return this.getFacadeRoot().has(key);
  }

  /** Stores `value` under `key` for `ttl` (the configured `ttl` when omitted; `null` for no expiry). */
  static set(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    return this.getFacadeRoot().set(key, value, ttl);
  }

  /** Removes `key`; resolves to whether there was a value under it. */
  static delete(key: string): Promise<boolean> {
    return this.getFacadeRoot().delete(key);
  }

  /** The value under `key`, removed from the cache. */
  static pull<T = unknown>(key: string): Promise<T | undefined> {
    return this.getFacadeRoot().pull<T>(key);
  }

  /** The value under `key`, or else what `compute` resolves to, stored for `ttl`. */
  static remember<T>(key: string, compute: () => T | Promise<T>): Promise<T>;
  static remember<T>(
    key: string,
    ttl: CacheTtl | undefined,
    compute: () => T | Promise<T>,
  ): Promise<T>;
  static remember<T>(
    key: string,
    ttlOrCompute: CacheTtl | undefined | (() => T | Promise<T>),
    compute?: () => T | Promise<T>,
  ): Promise<T> {
    const root = this.getFacadeRoot();
    return typeof ttlOrCompute === "function"
      ? root.remember<T>(key, ttlOrCompute)
      : root.remember<T>(key, ttlOrCompute, compute!);
  }

  /** The cache scoped to `tags`, whose `flush()` drops every value written under them. */
  static tags(...tags: (string | string[])[]): TaggedCache {
    return this.getFacadeRoot().tags(...tags);
  }

  /** Removes everything in the store. */
  static flush(): Promise<void> {
    return this.getFacadeRoot().flush();
  }
}
