import { Log } from "../../facades/Log";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { DatabaseQueueDriver } from "../queue/DatabaseQueueDriver";
import type { QueueConfig } from "../queue/config";
import { RateLimiter } from "./RateLimiter";
import { rateLimiterConfigDefaults, type RateLimiterConfig } from "./config";
import { InMemoryRateLimiter } from "./drivers/InMemoryRateLimiterDriver";

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

  /**
   * Warns, in production, when the queue keeps its jobs in the database but
   * the limiter counts in memory (#1341). An app that chose durable jobs
   * usually expects its limits to last as long, and with the in-memory driver
   * every deploy resets them and every instance counts on its own.
   */
  async boot() {
    if (process.env.NODE_ENV !== "production") return;
    const declared = this.app.config.get<RateLimiterConfig>("ratelimiter", {});
    if (declared.driver !== undefined && !(declared.driver instanceof InMemoryRateLimiter)) return;
    if (!durableQueue(this.app.config.get<QueueConfig>("queue", {}).driver)) return;
    Log.warning(
      "[gemi] The queue keeps its jobs in the database, but rate limits are counted in memory: " +
        "every deploy resets them, and each instance counts on its own. Set `driver: new " +
        "DatabaseRateLimiter()` (or `RedisRateLimiter`) in app/config/ratelimiter.ts.",
    );
  }
}

function durableQueue(driver: QueueConfig["driver"]): boolean {
  return driver === "database" || driver instanceof DatabaseQueueDriver;
}
