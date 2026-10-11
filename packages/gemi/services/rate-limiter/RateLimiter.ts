import { RateLimitExceededError } from "../../http/RateLimitExceededError";
import type { RateLimiterConfig } from "./config";
import type { RateLimiterDriver } from "./drivers/RateLimiterDriver";
import type { RateLimitResult } from "./types";

export interface ConsumeOptions {
  /** Requests allowed per window. Defaults to the configured `limit`. */
  limit?: number;
  /** Window length in **seconds**. Defaults to the configured `window`. */
  window?: number;
  /** How much this call costs. Defaults to `1`. */
  cost?: number;
}

/**
 * What a refusal from `enforce` says: a string, or one built from the result
 * that refused it (`retryAfter` is in milliseconds).
 */
export type RateLimitMessage = string | ((result: RateLimitResult) => string);

export class RateLimiter {
  static token = "ratelimiter";

  constructor(public config: Required<RateLimiterConfig>) {}

  get driver(): RateLimiterDriver {
    return this.config.driver;
  }

  /**
   * Records one hit against `key` and reports whether it fits the budget.
   *
   * Windows are given in seconds here — the unit routes, middleware and config
   * are written in — and converted to the milliseconds drivers work in.
   */
  async consume(
    key: string,
    options: ConsumeOptions = {},
  ): Promise<RateLimitResult> {
    const limit = options.limit ?? this.config.limit;
    const window = options.window ?? this.config.window;
    const cost = options.cost ?? 1;

    // A zero window divides by zero inside the sliding-window maths and a
    // negative cost hands out budget instead of spending it. Both mean the
    // caller passed something nonsensical, so say so rather than limiting in a
    // way nobody can explain later.
    assertPositive("window", window);
    assertPositive("limit", limit);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error(`Rate limiter cost must be zero or greater, got ${cost}`);
    }

    return await this.config.driver.consume({
      key,
      limit,
      window: window * 1000,
      cost,
    });
  }

  /**
   * `consume`, refusing the request when it does not fit: over budget it throws
   * `RateLimitExceededError`, the same 429 the `rate-limit` middleware answers
   * (`Retry-After` and `X-RateLimit-*` headers, `{ error: { kind: "rate_limit",
   * message, status: 429, retryAfter } }`). Within budget it returns the result.
   */
  async enforce(
    key: string,
    options: ConsumeOptions = {},
    message?: RateLimitMessage,
  ): Promise<RateLimitResult> {
    const result = await this.consume(key, options);
    if (!result.allowed) {
      throw new RateLimitExceededError(
        result,
        typeof message === "function" ? message(result) : message,
      );
    }
    return result;
  }
}

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Rate limiter ${name} must be greater than zero, got ${value}`,
    );
  }
}
