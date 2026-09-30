import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { redisConfigDefaults, type RedisConfig } from "./config";
import { RedisManager } from "./RedisManager";

export class RedisServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      RedisManager,
      () =>
        new RedisManager(
          withDefaults(
            redisConfigDefaults(),
            this.app.config.get<RedisConfig>("redis", {}),
          ),
        ),
    );
  }

  /**
   * Closes the client, if anything built one. Under `gemi dev` this is what
   * keeps each `bun --hot` reload from leaving a Redis connection behind; see
   * `DatabaseServiceProvider.shutdown`.
   */
  shutdown() {
    if (!this.app.resolved(RedisManager)) return;
    this.app.make(RedisManager).close();
  }
}
