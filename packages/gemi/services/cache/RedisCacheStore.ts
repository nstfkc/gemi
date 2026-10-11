import { app } from "../../foundation/app";
import { RedisManager } from "../redis/RedisManager";
import type { CacheStore } from "./CacheStore";

/**
 * The slice of Bun's `RedisClient` this store needs: any client exposing
 * `send(command, args)` works, which keeps the store testable without a live
 * server. Same shape as `RateLimiterRedisClient`.
 */
export interface CacheRedisClient {
  send(command: string, args: string[]): Promise<any>;
}

export interface RedisCacheStoreOptions {
  /**
   * Client to run against. Defaults to the app's shared client from
   * `RedisServiceProvider` (`app/config/redis.ts`, else `REDIS_URL`), resolved
   * on first use, so constructing the store needs no kernel and opens no
   * connection.
   */
  client?: CacheRedisClient;

  /**
   * Prepended to every key, and the only keys `flush()` removes. Give each app
   * (and each environment) sharing one Redis its own. Default `"gemi:cache:"`.
   */
  prefix?: string;
}

/** Keys `flush()` asks `SCAN` for per round trip. */
const SCAN_COUNT = "500";

/**
 * A cache in Redis, shared by every instance of the app: a `delete` or a tag
 * `flush` on one instance is seen by all of them on their next read.
 *
 * ```ts
 * // app/config/cache.ts
 * import { defineCacheConfig } from "gemi/services";
 *
 * export default defineCacheConfig({ store: "redis" });
 * ```
 *
 * Expiry is Redis's own (`SET … PX`), measured on the server's clock. Errors
 * are not swallowed: a failed `delete` that looked like a success would leave
 * a stale value in place, so the caller hears about it.
 */
export class RedisCacheStore implements CacheStore {
  readonly prefix: string;
  private readonly injectedClient?: CacheRedisClient;

  constructor(options: RedisCacheStoreOptions = {}) {
    this.injectedClient = options.client;
    this.prefix = options.prefix ?? "gemi:cache:";
  }

  async get(key: string): Promise<string | null> {
    const value = await this.client.send("GET", [this.prefix + key]);
    return value === null || value === undefined ? null : String(value);
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    const args = [this.prefix + key, value];
    if (ttlMs !== null) args.push("PX", String(Math.max(1, Math.round(ttlMs))));
    await this.client.send("SET", args);
  }

  async delete(key: string): Promise<boolean> {
    return Number(await this.client.send("DEL", [this.prefix + key])) > 0;
  }

  /**
   * Removes every key under `prefix`, with `SCAN` and `UNLINK`, so a large
   * cache is cleared without blocking the server. Keys written while it runs
   * may survive it.
   */
  async flush(): Promise<void> {
    if (this.prefix === "") {
      throw new Error(
        "RedisCacheStore refuses to flush with an empty prefix: that would delete every key in the database.",
      );
    }
    const client = this.client;
    const match = `${escapeGlob(this.prefix)}*`;
    let cursor = "0";
    do {
      const reply = await client.send("SCAN", [cursor, "MATCH", match, "COUNT", SCAN_COUNT]);
      const [next, keys] = Array.isArray(reply) ? reply : ["0", []];
      cursor = String(next);
      if (Array.isArray(keys) && keys.length > 0) {
        await client.send("UNLINK", keys.map(String));
      }
    } while (cursor !== "0");
  }

  private get client(): CacheRedisClient {
    if (this.injectedClient) return this.injectedClient;

    // `bound` first: a store with an injected client never needs
    // `RedisServiceProvider`, and `make` on an unbound token throws.
    const container = app();
    const client = container.bound(RedisManager)
      ? container.make(RedisManager).client
      : undefined;

    if (!client) {
      throw new Error(
        "RedisCacheStore could not reach the Redis client. Register RedisServiceProvider on your application, or pass a client: new RedisCacheStore({ client }).",
      );
    }
    return client;
  }
}

/** Escapes the characters `MATCH` treats as a pattern, so a prefix matches only itself. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\^-]/g, (char) => `\\${char}`);
}
