import { createHash } from "node:crypto";

import { DatabaseManager } from "../../../database/DatabaseManager";
import { app } from "../../../foundation/app";
import { DatabaseLockStore } from "../../lock/DatabaseLockStore";
import type { LockStore } from "../../lock/LockStore";
import type { ConsumeParams, RateLimitResult } from "../types";
import { RateLimiterDriver } from "./RateLimiterDriver";

export interface DatabaseRateLimiterOptions {
  /**
   * Where the counters live. Default: a `DatabaseLockStore` on the app's
   * default database connection, over `table`. Pass a store (or a function
   * that builds one, asked on the first call) to count somewhere else.
   */
  store?: LockStore | (() => LockStore);
  /**
   * The locks table the default store uses. Default `gemi_locks`, the table
   * the database queue's locks already use: the limiter's rows are kept apart
   * by `prefix`.
   */
  table?: string;
  /** Prepended to every key, so limiter rows never meet a lock's. Default `ratelimit:`. */
  prefix?: string;
  /**
   * Every this many calls, `prune()` runs in the background and deletes up to
   * `pruneBatch` ended windows, so the table does not keep a row for every
   * key ever seen (a per-IP limit sees a new key for every new address).
   * Default `1000`; `0` turns it off, for an app that calls `prune()` itself
   * (from a cron job, say).
   */
  pruneEvery?: number;
  /** The most rows one automatic `prune()` deletes. Default `1000`. */
  pruneBatch?: number;
}

/**
 * Keys longer than this are stored as their SHA-256, so a long key (a long
 * `x-forwarded-for`, an email address) fits MySQL's 191-character name column.
 */
const MAX_NAME = 150;

/**
 * Counts in the application's database, so budgets survive a deploy or a
 * restart and are shared by every instance on the database. No Redis needed.
 *
 * Each key is one row of the locks table, counted with the lock store's
 * fixed-window `hit()`: the window starts at the first call after the last
 * window ended and lasts `window`. That differs from the in-memory and Redis
 * drivers' sliding window: a caller who spends a whole budget at the end of a
 * window gets a new one when the next window starts. That is the right shape
 * for quotas (so many a day); for a burst limit on a route, the sliding
 * drivers are smoother.
 *
 * Each call is one guarded write, so concurrent calls never admit more than
 * the limit: on Postgres and SQLite one upsert, plus a read when it refuses;
 * on MySQL three statements (seed, update, read). `allowed` is exact.
 * `remaining` is exact for an allowed call on Postgres and SQLite; on MySQL,
 * and `retryAfter` on a refusal everywhere, are read just after the decision
 * and may already include other clients' calls: treat them as hints.
 *
 * Costs are whole numbers: a fractional `cost` is rounded up, and a cost of
 * `0` always passes (a peek, not a check). A database error rejects the call,
 * so the request fails rather than going unlimited. Ended windows are deleted
 * as it goes (`pruneEvery`) or by `prune()`.
 */
export class DatabaseRateLimiter extends RateLimiterDriver {
  private resolved: LockStore | undefined;
  private readonly prefix: string;
  private readonly pruneEvery: number;
  private readonly pruneBatch: number;
  private calls = 0;
  private pruning: Promise<unknown> | undefined;

  constructor(private readonly options: DatabaseRateLimiterOptions = {}) {
    super();
    this.prefix = options.prefix ?? "ratelimit:";
    if (this.prefix === "") throw new Error("DatabaseRateLimiter needs a prefix: its rows share the locks table.");
    this.pruneEvery = Math.max(0, Math.floor(options.pruneEvery ?? 1_000));
    this.pruneBatch = Math.max(1, Math.floor(options.pruneBatch ?? 1_000));
  }

  /**
   * Deletes up to `batch` of this limiter's windows that have ended (only
   * names under its `prefix`, never a lock's), and resolves to how many. A
   * store without `pruneWindows` resolves to `0`.
   */
  async prune(batch = this.pruneBatch): Promise<number> {
    const store = this.store();
    return store.pruneWindows ? await store.pruneWindows(this.prefix, batch) : 0;
  }

  async consume(params: ConsumeParams): Promise<RateLimitResult> {
    const { limit, window } = params;
    const cost = Math.ceil(params.cost ?? 1);
    const now = Date.now();

    // Never fits, and a new window would admit it, so it is refused here.
    if (cost > limit) {
      return { allowed: false, limit, remaining: 0, resetAt: now + window, retryAfter: window };
    }

    this.maybePrune();
    const hit = await this.store().hit(this.nameOf(params.key), limit, window, cost);
    const resetAt = now + hit.resetInMs;
    if (!hit.allowed) {
      return { allowed: false, limit, remaining: 0, resetAt, retryAfter: Math.max(1, hit.resetInMs) };
    }
    const count = hit.count ?? limit;
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, Math.floor(limit - count)),
      resetAt,
      retryAfter: 0,
    };
  }

  /** One background `prune()` every `pruneEvery` calls, never two at once. */
  private maybePrune() {
    if (this.pruneEvery === 0 || ++this.calls % this.pruneEvery !== 0 || this.pruning) return;
    this.pruning = this.prune()
      .catch((error: unknown) => console.error("[gemi] DatabaseRateLimiter could not prune ended windows", error))
      .finally(() => {
        this.pruning = undefined;
      });
  }

  private store(): LockStore {
    if (this.resolved) return this.resolved;
    const { store, table } = this.options;
    this.resolved =
      typeof store === "function"
        ? store()
        : (store ?? new DatabaseLockStore(app().make(DatabaseManager), { table }));
    return this.resolved;
  }

  private nameOf(key: string): string {
    const name = `${this.prefix}${key}`;
    if (name.length <= MAX_NAME) return name;
    return `${this.prefix}#${createHash("sha256").update(key).digest("hex")}`;
  }
}
