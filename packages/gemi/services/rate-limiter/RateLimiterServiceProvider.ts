import { ServiceProvider } from "../ServiceProvider";
import { InMemoryRateLimiter } from "./drivers/InMemoryRateLimiterDriver";
import { RateLimiterDriver } from "./drivers/RateLimiterDriver";

export class RateLimiterServiceProvider extends ServiceProvider {
  /**
   * Where counters live. In-process by default; swap in `RedisRateLimiter` once
   * the app runs on more than one instance.
   */
  driver: RateLimiterDriver = new InMemoryRateLimiter();

  /** Requests allowed per window when the `rate-limit` DSL omits a limit. */
  limit = 1000;

  /** Window length in **seconds** when the `rate-limit` DSL omits one. */
  window = 60;

  boot() {}
}
