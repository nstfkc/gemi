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
 * Every call is one guarded `UPDATE` (plus a `SELECT` for the result), so
 * concurrent calls never admit more than the limit. Costs are whole numbers: a
 * fractional `cost` is rounded up. A database error rejects the call, so the
 * request fails rather than going unlimited.
 */
export class DatabaseRateLimiter extends RateLimiterDriver {
  private resolved: LockStore | undefined;
  private readonly prefix: string;

  constructor(private readonly options: DatabaseRateLimiterOptions = {}) {
    super();
    this.prefix = options.prefix ?? "ratelimit:";
  }

  async consume(params: ConsumeParams): Promise<RateLimitResult> {
    const { limit, window } = params;
    const cost = Math.ceil(params.cost ?? 1);
    const now = Date.now();

    // Never fits, and a new window would admit it, so it is refused here.
    if (cost > limit) {
      return { allowed: false, limit, remaining: 0, resetAt: now + window, retryAfter: window };
    }

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
