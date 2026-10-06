import { app } from "../../../foundation/app";
import { RateLimiter } from "../../rate-limiter/RateLimiter";

export type Budget = { limit: number; window: number };

/**
 * Spends one unit of `key`'s budget with the app's `RateLimiter`. Answers
 * `null` when it fits, or the seconds to wait when it does not. No limiter
 * bound (a kernel without the provider) means no limit.
 */
export async function overBudget(key: string, budget: Budget): Promise<number | null> {
  const limiter = resolveLimiter();
  if (!limiter) return null;
  const result = await limiter.consume(key, budget);
  return result.allowed ? null : Math.max(1, Math.ceil(result.retryAfter / 1000));
}

function resolveLimiter(): RateLimiter | null {
  try {
    const container = app();
    return container.bound(RateLimiter) ? container.make(RateLimiter) : null;
  } catch {
    return null;
  }
}
