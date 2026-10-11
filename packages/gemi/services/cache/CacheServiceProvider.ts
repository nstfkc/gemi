import { ServiceProvider } from "../../support/ServiceProvider";
import { CacheManager } from "./CacheManager";
import type { CacheConfig } from "./config";

export class CacheServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      CacheManager,
      () =>
        new CacheManager(this.app.config.get<CacheConfig>("cache", {}), {
          application: this.app,
        }),
    );
  }
}
