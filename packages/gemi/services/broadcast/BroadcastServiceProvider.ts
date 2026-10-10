import { assertChannelPatterns, type ChannelRouterClass } from "../../http/ChannelRouter";
import { ServiceProvider } from "../../support/ServiceProvider";
import { BroadcastManager } from "./BroadcastManager";
import type { BroadcastConfig } from "./config";
import { SocketHub } from "./SocketHub";

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
    // The WebSocket transport, built by the HTTP server (`Kernel.sockets()`)
    // when the app declares `route.channels`.
    this.app.singleton(SocketHub, () => new SocketHub(this.app.make(BroadcastManager), this.app));
  }

  /**
   * Fails the boot on a malformed channel pattern, rather than refusing every
   * subscription to it at runtime.
   */
  boot() {
    const Channels = this.app.config.get<ChannelRouterClass | undefined>("route.channels");
    if (Channels) assertChannelPatterns(new Channels());
  }

  /**
   * Says `bye` to the sockets (the server's drain did already, in
   * production; a dev reload retiring this application did not), then stops
   * receiving and closes the driver's connections.
   */
  async shutdown() {
    if (this.app.resolved(SocketHub)) this.app.make(SocketHub).shutdown();
    if (!this.app.resolved(BroadcastManager)) return;
    await this.app.make(BroadcastManager).close();
  }
}
