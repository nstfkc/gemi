/**
 * Where cached values live. Four methods, all async so a network store fits,
 * and all on strings: `CacheManager` JSON-encodes values before they get here,
 * so every store, the in-memory one included, hands back what a fresh decode
 * would. Tags are built by the manager on top of these four, so a store of
 * the app's own gets them too.
 *
 * Durations cross this interface as relative milliseconds, as they do for
 * `LockStore`, so a store shared between machines measures expiry on its own
 * clock.
 */
export interface CacheStore {
  /** The value under `key`, or `null` when there is none or it expired. */
  get(key: string): Promise<string | null>;

  /**
   * Stores `value` under `key`, replacing what was there. `ttlMs` is how long
   * it lives, in milliseconds (always more than `0`); `null` keeps it until it
   * is deleted, flushed or evicted.
   */
  set(key: string, value: string, ttlMs: number | null): Promise<void>;

  /** Removes `key`, and resolves to whether there was a live value under it. */
  delete(key: string): Promise<boolean>;

  /** Removes every value this store holds (for a shared Redis, every key under its prefix). */
  flush(): Promise<void>;
}
