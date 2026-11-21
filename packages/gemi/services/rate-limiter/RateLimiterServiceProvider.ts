import { Log } from "../../facades/Log";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { DatabaseQueueDriver } from "../queue/DatabaseQueueDriver";
import type { QueueConfig } from "../queue/config";
import { QueueManager } from "../queue/QueueManager";
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

  /**
   * Warns, in production, when the queue keeps its jobs in the database but
   * the limiter was left on its in-memory default (#1341). An app that chose
   * durable jobs usually expects its limits to last as long, and with the
   * in-memory driver every deploy resets them and every instance counts on
   * its own. Setting `driver` at all, `InMemoryRateLimiter` included, is a
   * choice and silences it. Each process that boots the app says it once.
   */
  async boot() {
    if (process.env.NODE_ENV !== "production") return;
    if (this.app.config.get<RateLimiterConfig>("ratelimiter", {}).driver !== undefined) return;
    if (!this.durableQueue()) return;
    Log.warning(
      "[gemi] The queue keeps its jobs in the database, but rate limits are counted in memory: " +
        "every deploy resets them, and each instance counts on its own. Set `driver: new " +
        "DatabaseRateLimiter()` (or `RedisRateLimiter`, or `InMemoryRateLimiter` to keep it) in " +
        "app/config/ratelimiter.ts.",
    );
  }

  /** Whether the queue's driver is the database one, the function form included. */
  private durableQueue(): boolean {
    const driver = this.app.config.get<QueueConfig>("queue", {}).driver;
    if (driver === "database" || driver instanceof DatabaseQueueDriver) return true;
    if (typeof driver !== "function" || !this.app.bound(QueueManager)) return false;
    try {
      return this.app.make(QueueManager).driver instanceof DatabaseQueueDriver;
    } catch {
      return false;
    }
  }
}
