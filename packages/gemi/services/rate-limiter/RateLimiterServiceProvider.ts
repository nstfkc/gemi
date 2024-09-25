import { ServiceProvider } from "../ServiceProvider";
import { InMemoryRateLimiter } from "./drivers/InMemoryRateLimiterDriver";
import { RateLimiterDriver } from "./drivers/RateLimiterDriver";

export class RateLimiterServiceProvider extends ServiceProvider {
  driver: RateLimiterDriver = new InMemoryRateLimiter();

  boot() {}
}
