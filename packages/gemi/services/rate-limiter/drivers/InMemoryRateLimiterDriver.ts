import { buildResult, estimateUsage, windowStartFor } from "../slidingWindow";
import type { ConsumeParams, RateLimitResult } from "../types";
import { RateLimiterDriver } from "./RateLimiterDriver";

interface Bucket {
  /** Window length this bucket was counted with, so config changes reset it. */
  window: number;
  /** The limit of the last consume, so eviction can tell a full bucket from an idle one. */
  limit: number;
  windowStart: number;
  current: number;
  previous: number;
}

export interface InMemoryRateLimiterOptions {
  /**
   * Hard cap on tracked keys. Reached only by traffic that never repeats a key
   * (spoofed `x-forwarded-for`, for instance); the map is swept of dead buckets
   * first and only then evicts live ones down to 90% of the cap, the least
   * spent (as a share of their limit) first and, among equals, the oldest
   * touched first.
   *
   * Spending-first is what keeps key churn from buying a fresh budget: a
   * bucket close to its limit (a code's guesses, an address under attack)
   * outlives the one-hit keys an attacker makes to push it out, and is only
   * reached once every less-spent key has gone. Eviction can still reset a
   * bucket under enough churn, so a limit that guards a secret belongs on a
   * shared store (`RedisRateLimiter`) in production.
   *
   * Defaults to 100k keys — a few MB, and far more than a single instance
   * legitimately sees inside one window.
   */
  maxKeys?: number;
}

/**
 * Per-process rate limiter. The default driver, and the right one for a single
 * instance or for development.
 *
 * State lives in this process only: with N instances behind a load balancer the
 * effective limit is N × the configured limit, and it resets on deploy. Point
 * the service provider at `RedisRateLimiter` once you run more than one.
 */
export class InMemoryRateLimiter extends RateLimiterDriver {
  private buckets = new Map<string, Bucket>();
  private maxKeys: number;

  constructor(options: InMemoryRateLimiterOptions = {}) {
    super();
    this.maxKeys = Math.max(1, options.maxKeys ?? 100_000);
  }

  consume(params: ConsumeParams): RateLimitResult {
    const { key, limit, window } = params;
    const cost = params.cost ?? 1;
    const now = Date.now();
    const windowStart = windowStartFor(now, window);
    const elapsed = now - windowStart;

    const bucket = this.roll(key, window, windowStart);
    bucket.limit = limit;
    const usage = estimateUsage(
      bucket.current,
      bucket.previous,
      elapsed,
      window,
    );
    const allowed = usage + cost <= limit;

    if (allowed) {
      bucket.current += cost;
    }

    // Re-inserting moves the key to the end of the iteration order, which is
    // what makes eviction least-recently-used rather than arbitrary.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) {
      this.evict(now);
    }

    return buildResult({
      allowed,
      current: bucket.current,
      previous: bucket.previous,
      now,
      elapsed,
      window,
      limit,
      cost,
    });
  }

  /** Drops all counters. Mainly useful in tests. */
  clear() {
    this.buckets.clear();
  }

  /** Number of tracked keys. Exposed for tests and diagnostics. */
  get size() {
    return this.buckets.size;
  }

  /** Advances a bucket to `windowStart`, creating it when absent or stale. */
  private roll(key: string, window: number, windowStart: number): Bucket {
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.window !== window) {
      return { window, limit: 0, windowStart, current: 0, previous: 0 };
    }

    if (bucket.windowStart === windowStart) {
      return bucket;
    }

    if (bucket.windowStart + window === windowStart) {
      bucket.previous = bucket.current;
      bucket.current = 0;
      bucket.windowStart = windowStart;
      return bucket;
    }

    // Idle for more than a full window: everything it held has decayed away.
    bucket.previous = 0;
    bucket.current = 0;
    bucket.windowStart = windowStart;
    return bucket;
  }

  private evict(now: number) {
    for (const [key, bucket] of this.buckets) {
      // Fully decayed — it would be reset on the next read anyway.
      if (now - bucket.windowStart >= bucket.window * 2) {
        this.buckets.delete(key);
      }
    }

    // Down to 90% of the cap rather than to the cap, so the scan below runs
    // once per tenth of `maxKeys` new keys instead of on every one.
    const target = this.maxKeys - Math.floor(this.maxKeys / 10);
    if (this.buckets.size <= target) return;

    // Still over, so the traffic is live rather than stale. Drop the least
    // spent buckets first, the least recently touched among equals (the sort
    // is stable over the map's LRU order). The one-hit keys of churn go before
    // a bucket that has been counting something, so churning keys does not
    // hand a fresh budget to whoever is being limited.
    const ranked = [...this.buckets].map(([key, bucket], order) => ({
      key,
      order,
      spent: bucket.limit > 0 ? (bucket.current + bucket.previous) / bucket.limit : 0,
    }));
    ranked.sort((a, b) => a.spent - b.spent || a.order - b.order);
    for (const { key } of ranked) {
      if (this.buckets.size <= target) break;
      this.buckets.delete(key);
    }
  }
}
