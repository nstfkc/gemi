import type { Application } from "../../foundation/Application";
import type { Duration } from "../queue/workflow/duration";
import type { CacheStore } from "./CacheStore";
import type { MemoryCacheStoreOptions } from "./MemoryCacheStore";
import type { RedisCacheStoreOptions } from "./RedisCacheStore";

// Config key: `cache` (`app/config/cache.ts`).
export interface CacheConfig {
  /**
   * Where values live: `"memory"`, `"redis"`, a `CacheStore`, or a function
   * returning one, called once with the application.
   *
   * `"memory"` is the default and is **per process**: each instance keeps
   * its own, so an eviction on one is not seen by the others. See
   * `MemoryCacheStore`.
   *
   * `"redis"` is shared by every instance, on the app's own Redis connection
   * (`app/config/redis.ts`, else `REDIS_URL`). See `RedisCacheStore`.
   */
  store?: "memory" | "redis" | CacheStore | ((application: Application) => CacheStore);

  /**
   * How long a value lives when the call does not say: milliseconds, or a
   * string such as `"30s"`, `"5m"`, `"1h"`, `"7d"`. Default `null`: until it
   * is deleted, flushed or evicted.
   */
  ttl?: Duration | null;

  /** The `"memory"` store's settings: `maxEntries` (default `10000`). */
  memory?: Pick<MemoryCacheStoreOptions, "maxEntries">;

  /**
   * The `"redis"` store's settings: `prefix` (default `"gemi:cache:"`), the
   * keys it writes and the only ones `flush()` removes.
   */
  redis?: Pick<RedisCacheStoreOptions, "prefix">;
}

export function defineCacheConfig(config: CacheConfig): CacheConfig {
  return config;
}

export function cacheConfigDefaults(): Required<Pick<CacheConfig, "store" | "ttl">> {
  return { store: "memory", ttl: null };
}
