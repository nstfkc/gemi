import {
  type ConsumeOptions,
  RateLimiterServiceContainer,
} from "../services/rate-limiter/RateLimiterServiceContainer";
import type { RateLimitResult } from "../services/rate-limiter/types";

/**
 * The rate limiter, outside of middleware — for the things a route-level limit
 * cannot express: a per-user budget on an expensive job, a cooldown on
 * password-reset emails, a quota on a third-party API you pay for.
 *
 * ```ts
 * const result = await RateLimiter.consume(`reset-password:${email}`, {
 *   limit: 3,
 *   window: 3600,
 * });
 *
 * if (!result.allowed) {
 *   return { error: `Try again in ${Math.ceil(result.retryAfter / 1000)}s` };
 * }
 * ```
 */
export class RateLimiter {
  /** Records one hit against `key` and reports whether it fits the budget. */
  static consume(
    key: string,
    options: ConsumeOptions = {},
  ): Promise<RateLimitResult> {
    return RateLimiterServiceContainer.use().consume(key, options);
  }
}
