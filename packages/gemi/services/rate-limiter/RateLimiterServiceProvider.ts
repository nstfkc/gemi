import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { RateLimiter } from "./RateLimiter";
import { rateLimiterConfigDefaults, type RateLimiterConfig } from "./config";

export class RateLimiterServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      RateLimiter,
      () =>
        new RateLimiter(
          withDefaults(
            rateLimiterConfigDefaults(),
            this.app.config.get<RateLimiterConfig>("ratelimiter", {}),
          ),
        ),
    );
  }
}
