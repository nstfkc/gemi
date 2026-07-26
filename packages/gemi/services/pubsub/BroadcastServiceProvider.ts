import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { BroadcastManager } from "./BroadcastManager";
import { broadcastConfigDefaults, type BroadcastConfig } from "./config";

export class BroadcastServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      BroadcastManager,
      () =>
        new BroadcastManager(
          withDefaults(
            broadcastConfigDefaults(),
            this.app.config.get<BroadcastConfig>("broadcast", {}),
          ),
        ),
    );
  }
}
