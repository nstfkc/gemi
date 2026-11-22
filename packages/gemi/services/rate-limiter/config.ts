import { InMemoryRateLimiter } from "./drivers/InMemoryRateLimiterDriver";
import type { RateLimiterDriver } from "./drivers/RateLimiterDriver";

// Config key: `ratelimiter`. Derived from `RateLimiterServiceProvider`.
export interface RateLimiterConfig {
  /**
   * Where counters live. In-process by default, so a restart or a deploy
   * resets every budget. `DatabaseRateLimiter` keeps them in the app's
   * database, and `RedisRateLimiter` in Redis; use one once the app runs on
   * more than one instance or a budget must outlast a deploy.
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
