import type { CacheStore } from "./CacheStore";

export interface MemoryCacheStoreOptions {
  /**
   * How many entries to keep. When a write would go over, the least recently
   * used entry makes room. Default `10000`.
   */
  maxEntries?: number;

  /** The clock expiry is measured on, in milliseconds. For tests. Default `Date.now`. */
  now?: () => number;
}

type Entry = { value: string; expiresAt: number | null };

/**
 * A cache in this process's memory: the default store.
 *
 * Per process. Each instance of the app keeps its own, and a restart (or a
 * `gemi dev` reload) empties it, so a `delete` or a tag `flush` on one
 * instance is not seen by the others. That is fine for results that are
 * expensive to make and cheap to lose; anything that must be evicted
 * everywhere at once wants `RedisCacheStore`.
 *
 * Bounded by `maxEntries`, least recently used first. An expired entry is
 * dropped when it is next read, or when it is the one that makes room.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError(
        `MemoryCacheStore maxEntries is a whole number of 1 or more; got ${maxEntries}.`,
      );
    }
    this.maxEntries = maxEntries;
    this.now = options.now ?? Date.now;
  }

  /** How many entries are held, expired ones not yet dropped included. */
  get size(): number {
    return this.entries.size;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.live(key);
    if (!entry) return null;
    // Re-inserting moves the key to the end of the Map's order, which is
    // what makes the first key the least recently used one.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number | null): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: ttlMs === null ? null : this.now() + ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  async delete(key: string): Promise<boolean> {
    const live = this.live(key) !== undefined;
    this.entries.delete(key);
    return live;
  }

  async flush(): Promise<void> {
    this.entries.clear();
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
