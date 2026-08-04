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
}
