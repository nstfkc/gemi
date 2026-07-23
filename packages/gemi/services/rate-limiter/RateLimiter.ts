import type { RateLimiterConfig } from "./config";
import type { RateLimiterDriver } from "./drivers/RateLimiterDriver";

export class RateLimiter {
  static token = "ratelimiter";

  constructor(public config: Required<RateLimiterConfig>) {}

  get driver(): RateLimiterDriver {
    return this.config.driver;
  }

  consume(userId: string, requestPath: string): number {
    const driver = this.config.driver;
    return driver.consume(userId, requestPath);
  }
}
