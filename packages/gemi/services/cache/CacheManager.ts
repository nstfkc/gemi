import type { Application } from "../../foundation/Application";
import { type Duration, toMilliseconds } from "../queue/workflow/duration";
import { RedisManager } from "../redis/RedisManager";
import { withDefaults } from "../../support/withDefaults";
import type { CacheStore } from "./CacheStore";
import { cacheConfigDefaults, type CacheConfig } from "./config";
import { MemoryCacheStore } from "./MemoryCacheStore";
import { RedisCacheStore } from "./RedisCacheStore";

/**
 * How long a value lives: a `Duration` (milliseconds, or `"30s"`, `"5m"`,
 * `"1h"`, `"7d"`), or `null` for no expiry. Omitted, the `cache` slice's `ttl`
 * applies. `0` stores nothing and removes what was there.
 */
export type CacheTtl = Duration | null;

/*
 * The keys the manager writes into a store. Every kind has its own prefix so
 * an application key can never land on a tag's version:
 *
 * - `k:<key>` a plain value
 * - `tag:<tag>` the current version of a tag
 * - `t:<version>,<version>:<key>` a tagged value, under its tags' versions
 */
const PLAIN = "k:";
const TAG = "tag:";
const TAGGED = "t:";

type Read<T> = { found: true; value: T } | { found: false };

/**
 * The reads and writes shared by `CacheManager` and the `TaggedCache` that
 * `tags()` hands back. They differ only in where a key lives in the store.
 */
abstract class CacheRepository {
  /** The manager that owns the store; a manager is its own. */
  protected abstract readonly manager: CacheManager;

  /** Where `key` lives in the store. */
  protected abstract storeKey(key: string): Promise<string>;

  /** The value under `key`, or `undefined` when there is none or it expired. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const read = await this.manager.read<T>(await this.storeKey(key));
    return read.found ? read.value : undefined;
  }

  /** Whether a value is stored under `key`. A stored `null` counts. */
  async has(key: string): Promise<boolean> {
    return (await this.manager.read(await this.storeKey(key))).found;
  }

  /**
   * Stores `value` under `key`. It is JSON-encoded, on every store, so what
   * comes back is what a JSON round trip gives: a `Date` comes back as its ISO
   * string, a class instance as a plain object. `undefined` cannot be stored,
   * because `get` uses it for a miss; `null` can.
   */
  async set(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    await this.manager.write(await this.storeKey(key), value, ttl);
  }

  /** Removes `key`, and resolves to whether there was a value under it. */
  async delete(key: string): Promise<boolean> {
    return this.manager.store.delete(await this.storeKey(key));
  }

  /** The value under `key`, removed from the cache; `undefined` when there was none. */
  async pull<T = unknown>(key: string): Promise<T | undefined> {
    const storeKey = await this.storeKey(key);
    const read = await this.manager.read<T>(storeKey);
    if (!read.found) return undefined;
    await this.manager.store.delete(storeKey);
    return read.value;
  }

  /**
   * The value under `key`, or else what `compute` resolves to, stored for
   * `ttl` (the `cache` slice's `ttl` when omitted).
   *
   * Concurrent calls for one key in one process that all miss share a single
   * `compute`, so a burst of requests for a cold key does the work once per
   * instance. A `compute` that throws stores nothing and rejects every caller
   * waiting on it. One that resolves `undefined` stores nothing.
   */
  remember<T>(key: string, compute: () => T | Promise<T>): Promise<T>;
  remember<T>(key: string, ttl: CacheTtl | undefined, compute: () => T | Promise<T>): Promise<T>;
  async remember<T>(
    key: string,
    ttlOrCompute: CacheTtl | undefined | (() => T | Promise<T>),
    maybeCompute?: () => T | Promise<T>,
  ): Promise<T> {
    const [ttl, compute] =
      typeof ttlOrCompute === "function"
        ? [undefined, ttlOrCompute]
        : [ttlOrCompute, maybeCompute];
    if (typeof compute !== "function") {
      throw new TypeError("Cache.remember needs a function that computes the value.");
    }
    return this.manager.rememberAt(await this.storeKey(key), ttl, compute);
  }
}

/**
 * The application's cache: `get` / `set` / `remember` with a TTL, `tags()`
 * for flushing a group of values at once, over a `CacheStore`.
 *
 * Bound in the container by `CacheServiceProvider` and reached through the
 * `Cache` facade. It can also be built directly, for a cache of its own:
 * `new CacheManager({ store: new MemoryCacheStore({ maxEntries: 100 }) })`.
 */
export class CacheManager extends CacheRepository {
  static token = "cache";

  readonly config: CacheConfig;
  private builtStore: CacheStore | undefined;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    config: CacheConfig = {},
    private readonly options: { application?: Application } = {},
  ) {
    super();
    this.config = withDefaults<CacheConfig, CacheConfig>(cacheConfigDefaults(), config);
    // Fail on a malformed default now, rather than on the first write.
    if (this.config.ttl !== null && this.config.ttl !== undefined) {
      toMilliseconds(this.config.ttl);
    }
  }

  protected get manager(): CacheManager {
    return this;
  }

  /** The store, built from the `store` setting on first use. */
  get store(): CacheStore {
    return (this.builtStore ??= this.buildStore());
  }

  /**
   * A view of the cache whose values belong to `tags`: `flush()` on it makes
   * every value written through any view naming one of those tags unreadable,
   * on every instance sharing the store. Tag order does not matter.
   *
   * ```ts
   * await Cache.tags(`user:${user.id}`).remember(`profile:${user.id}`, "10m", load);
   * await Cache.tags(`user:${user.id}`).flush();
   * ```
   *
   * A tagged value is only reachable through the same set of tags, not by its
   * key alone. Flushing does not delete the old values: they become
   * unreachable and leave by their TTL (or, in memory, by eviction), so give
   * tagged values a TTL on a Redis store.
   */
  tags(...tags: (string | string[])[]): TaggedCache {
    const names = [...new Set(tags.flat())].sort();
    if (names.length === 0) {
      throw new TypeError("Cache.tags needs at least one tag.");
    }
    for (const name of names) {
      if (typeof name !== "string" || name === "") {
        throw new TypeError(`A cache tag is a non-empty string; got ${JSON.stringify(name)}.`);
      }
    }
    return new TaggedCache(this, names);
  }

  /** Removes everything in the store: for Redis, every key under its prefix. */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  protected async storeKey(key: string): Promise<string> {
    return PLAIN + checkKey(key);
  }

  /** @internal */
  async read<T>(storeKey: string): Promise<Read<T>> {
    const raw = await this.store.get(storeKey);
    if (raw === null) return { found: false };
    try {
      return { found: true, value: JSON.parse(raw) as T };
    } catch {
      // Not something the manager wrote. A miss, so the next write repairs it,
      // rather than an error on every read until it expires.
      return { found: false };
    }
  }

  /** @internal */
  async write(storeKey: string, value: unknown, ttl: CacheTtl | undefined): Promise<void> {
    if (value === undefined) {
      throw new TypeError(
        "Cache.set cannot store undefined: get() returns undefined for a miss. Store null instead.",
      );
    }
    const ttlMs = this.ttlMs(ttl);
    if (ttlMs === 0) {
      await this.store.delete(storeKey);
      return;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError(`Cache.set cannot store a ${typeof value}: it has no JSON form.`);
    }
    await this.store.set(storeKey, encoded, ttlMs);
  }

  /** @internal `remember` at a key already resolved to the store's. */
  async rememberAt<T>(
    storeKey: string,
    ttl: CacheTtl | undefined,
    compute: () => T | Promise<T>,
  ): Promise<T> {
    const read = await this.read<T>(storeKey);
    if (read.found) return read.value;

    const pending = this.inflight.get(storeKey);
    if (pending) return pending as Promise<T>;

    const run = (async () => {
      try {
        const value = await compute();
        if (value !== undefined) await this.write(storeKey, value, ttl);
        return value;
      } finally {
        this.inflight.delete(storeKey);
      }
    })();
    this.inflight.set(storeKey, run);
    return run;
  }

  /** @internal The current version of each tag, creating the missing ones. */
  async tagVersions(tags: string[]): Promise<string[]> {
    return Promise.all(
      tags.map(async (tag) => {
        const key = TAG + tag;
        const current = await this.store.get(key);
        if (current !== null) return current;
        // Two instances racing here each write their own; the later one wins
        // and values written under the earlier one become misses. A lost
        // version (an eviction, a flush) can only ever cause misses too:
        // versions are random, so an old one never comes back.
        const version = newVersion();
        await this.store.set(key, version, null);
        return version;
      }),
    );
  }

  /** @internal */
  async flushTags(tags: string[]): Promise<void> {
    await Promise.all(tags.map((tag) => this.store.set(TAG + tag, newVersion(), null)));
  }

  private ttlMs(ttl: CacheTtl | undefined): number | null {
    const resolved = ttl === undefined ? this.config.ttl : ttl;
    return resolved === null || resolved === undefined ? null : toMilliseconds(resolved);
  }

  private buildStore(): CacheStore {
    const { store } = this.config;
    if (store === undefined || store === "memory") {
      return new MemoryCacheStore(this.config.memory);
    }
    if (store === "redis") {
      const application = this.options.application;
      return new RedisCacheStore({
        ...this.config.redis,
        // The app's own client, resolved per command so a store built before
        // `RedisManager` is touched opens no connection; without an
        // application, `RedisCacheStore` finds it through `app()` itself.
        client: application
          ? { send: (command, args) => application.make(RedisManager).client.send(command, args) }
          : undefined,
      });
    }
    if (typeof store === "function") {
      const application = this.options.application;
      if (!application) {
        throw new Error("A cache store factory needs the application: build CacheManager with { application }.");
      }
      return store(application);
    }
    if (store && typeof store === "object") return store;
    throw new Error(
      `Unknown cache store ${JSON.stringify(store)} in app/config/cache.ts: use "memory", "redis", a CacheStore, or a function returning one.`,
    );
  }
}

/** What `Cache.tags(...)` returns: the cache, scoped to a set of tags. */
export class TaggedCache extends CacheRepository {
  constructor(
    protected readonly manager: CacheManager,
    readonly tagNames: readonly string[],
  ) {
    super();
  }

  /** Makes every value written under any of these tags unreadable, everywhere the store is shared. */
  async flush(): Promise<void> {
    await this.manager.flushTags([...this.tagNames]);
  }

  protected async storeKey(key: string): Promise<string> {
    checkKey(key);
    const versions = await this.manager.tagVersions([...this.tagNames]);
    return `${TAGGED}${versions.join(",")}:${key}`;
  }
}

function checkKey(key: string): string {
  if (typeof key !== "string" || key === "") {
    throw new TypeError(`A cache key is a non-empty string; got ${JSON.stringify(key)}.`);
  }
  return key;
}

function newVersion(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
