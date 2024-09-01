import { InMemoryRateLimiter } from "./drivers/InMemoryRateLimiterDriver";
import { RateLimiterDriver } from "./drivers/RateLimiterDriver";

export class RateLimiterServiceProvider {
  driver: RateLimiterDriver = new InMemoryRateLimiter();
}
