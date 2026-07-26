import { InMemoryRateLimiter } from "./drivers/InMemoryRateLimiterDriver";
import type { RateLimiterDriver } from "./drivers/RateLimiterDriver";

// Config key: `ratelimiter`. Derived from `RateLimiterServiceProvider`.
export interface RateLimiterConfig {
  /**
   * Where counters live. In-process by default; swap in `RedisRateLimiter` once
   * the app runs on more than one instance.
   */
  driver?: RateLimiterDriver;

  /** Requests allowed per window when the `rate-limit` DSL omits a limit. */
  limit?: number;

  /** Window length in **seconds** when the `rate-limit` DSL omits one. */
  window?: number;
}

export function defineRateLimiterConfig(
  config: RateLimiterConfig,
): RateLimiterConfig {
  return config;
}

export function rateLimiterConfigDefaults(): Required<RateLimiterConfig> {
  return {
    driver: new InMemoryRateLimiter(),
    limit: 1000,
    window: 60,
  };
}
