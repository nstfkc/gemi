import {
  type ConsumeOptions,
  type RateLimitMessage,
  RateLimiter as RateLimiterManager,
} from "../services/rate-limiter/RateLimiter";
import type { RateLimitResult } from "../services/rate-limiter/types";
import { Facade } from "./Facade";

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
 *
 * To refuse the request instead, `enforce` throws the middleware's 429:
 *
 * ```ts
 * await RateLimiter.enforce(`publish:${user.id}`, { limit: 10, window: 3600 },
 *   "You can publish 10 times an hour.");
 * ```
 */
export class RateLimiter extends Facade {
  static getFacadeAccessor() {
    return RateLimiterManager;
  }

  /** Records one hit against `key` and reports whether it fits the budget. */
  static consume(
    key: string,
    options: ConsumeOptions = {},
  ): Promise<RateLimitResult> {
    return this.getFacadeRoot().consume(key, options);
  }

  /**
   * Records one hit against `key`; over budget it throws
   * `RateLimitExceededError`, a 429 with `Retry-After` that `isRateLimitError`
   * recognises on the client, carrying `message` (default "Rate limit
   * exceeded"). `message` may be a function of the result, whose `retryAfter`
   * is in milliseconds. Within budget it returns the result.
   */
  static enforce(
    key: string,
    options: ConsumeOptions = {},
    message?: RateLimitMessage,
  ): Promise<RateLimitResult> {
    return this.getFacadeRoot().enforce(key, options, message);
  }
}
