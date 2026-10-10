import { assertChannelPatterns, type ChannelRouterClass } from "../../http/ChannelRouter";
import { ServiceProvider } from "../../support/ServiceProvider";
import { BroadcastManager } from "./BroadcastManager";
import type { BroadcastConfig } from "./config";

export class BroadcastServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      BroadcastManager,
      () =>
        new BroadcastManager(this.app.config.get<BroadcastConfig>("broadcast", {}), {
          application: this.app,
          channels: this.app.config.get<ChannelRouterClass | undefined>("route.channels"),
        }),
    );
  }

  /**
   * Fails the boot on a malformed channel pattern, rather than refusing every
   * subscription to it at runtime.
   */
  boot() {
    const Channels = this.app.config.get<ChannelRouterClass | undefined>("route.channels");
    if (Channels) assertChannelPatterns(new Channels());
  }

  /** Stops receiving and closes the driver's connections. */
  async shutdown() {
    if (!this.app.resolved(BroadcastManager)) return;
    await this.app.make(BroadcastManager).close();
  }
}
