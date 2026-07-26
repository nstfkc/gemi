import type { RateLimitResult } from "./types";

/**
 * The sliding-window-counter algorithm, shared by every driver.
 *
 * A fixed window is cheap but lets a client spend its whole budget at the end
 * of one window and again at the start of the next — twice the limit across a
 * window's worth of time. A true sliding log fixes that but has to keep a
 * timestamp per request.
 *
 * The counter variant keeps two integers per key (this window and the one
 * before it) and estimates usage by weighting the previous window by how much
 * of it still overlaps the trailing window:
 *
 *     usage = previous * (window - elapsed) / window + current
 *
 * That is a ~0.003% error on real traffic and costs two integers per key, so
 * it is what the in-memory and Redis drivers both implement.
 */

/** Epoch ms of the start of the window `now` falls into. */
export function windowStartFor(now: number, window: number) {
  return Math.floor(now / window) * window;
}

/** Weight of the previous window's count, from `1` down to `0`. */
export function previousWeight(elapsed: number, window: number) {
  if (window <= 0) return 0;
  return Math.min(1, Math.max(0, (window - elapsed) / window));
}

/** Estimated usage of the trailing `window` ending at `now`. */
export function estimateUsage(
  current: number,
  previous: number,
  elapsed: number,
  window: number,
) {
  return previous * previousWeight(elapsed, window) + current;
}

/**
 * How long until a request costing `cost` would be admitted, in milliseconds.
 *
 * Solves the usage equation for `elapsed` instead of guessing: the caller gets
 * a `Retry-After` that lands the moment capacity actually frees up rather than
 * at the end of the window, which for a sliding window is usually far too late.
 */
export function timeUntilAllowed(params: {
  current: number;
  previous: number;
  elapsed: number;
  window: number;
  limit: number;
  cost: number;
}) {
  const { current, previous, elapsed, window, limit, cost } = params;
  // Usage the bucket may sit at for this request to still fit.
  const budget = limit - cost;

  // The request can never fit, no matter how long the caller waits. Report a
  // full window rather than `Infinity` so a `Retry-After` header stays usable.
  if (budget < 0) return window;

  const remainingWindow = Math.max(0, window - elapsed);

  // Phase 1 — capacity frees up inside the current window as `previous` decays.
  if (previous > 0) {
    // previous * (window - e) / window + current = budget  =>  solve for e
    const target = window * (1 - (budget - current) / previous);
    if (target <= window) {
      return Math.max(0, Math.ceil(target - elapsed));
    }
  }

  // Phase 2 — `current` alone is already over budget, so nothing frees up until
  // the window rolls and `current` becomes the decaying `previous`.
  if (current <= budget) return remainingWindow;
  if (current <= 0) return remainingWindow;

  const target = window * (1 - budget / current);
  return remainingWindow + Math.max(0, Math.ceil(target));
}

/**
 * Turns a driver's post-operation counters into the result the caller sees.
 * `current` and `previous` are the counts *after* an allowed request has been
 * recorded, so every driver reports the same numbers for the same state.
 */
export function buildResult(params: {
  allowed: boolean;
  current: number;
  previous: number;
  now: number;
  elapsed: number;
  window: number;
  limit: number;
  cost: number;
}): RateLimitResult {
  const { allowed, current, previous, now, elapsed, window, limit, cost } =
    params;

  if (allowed) {
    const usage = estimateUsage(current, previous, elapsed, window);
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, Math.floor(limit - usage)),
      resetAt: now - elapsed + window,
      retryAfter: 0,
    };
  }

  const retryAfter = timeUntilAllowed({
    current,
    previous,
    elapsed,
    window,
    limit,
    cost,
  });

  return {
    allowed: false,
    limit,
    remaining: 0,
    resetAt: now + retryAfter,
    retryAfter,
  };
}
