import { InMemoryRateLimiter } from "./drivers/InMemoryRateLimiterDriver";
import type { RateLimiterDriver } from "./drivers/RateLimiterDriver";

// Config key: `ratelimiter`. Derived from `RateLimiterServiceProvider`.
export interface RateLimiterConfig {
  driver?: RateLimiterDriver;
}

export function defineRateLimiterConfig(
  config: RateLimiterConfig,
): RateLimiterConfig {
  return config;
}

export function rateLimiterConfigDefaults(): Required<RateLimiterConfig> {
  return {
    driver: new InMemoryRateLimiter(),
  };
}
