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
    assertSharedSecret(this.app.config.get<BroadcastConfig>("broadcast", {}));
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

/**
 * The redis driver carries one frame to every instance, and a `toOthers`
 * frame names the socket to skip by a tag keyed from `SECRET` (`socketTag`).
 * Without `SECRET` each process keys it at random, so the sender's own socket
 * on another instance would not recognise its tag and would get its own
 * emit back. Fails the boot in production; warns elsewhere.
 */
export function assertSharedSecret(
  config: BroadcastConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  if (config.driver !== "redis" || env.SECRET) return;
  const message =
    `[gemi] The "redis" broadcast driver needs SECRET set, the same on every ` +
    `instance: Broadcast.toOthers tags the sender's socket with a key derived ` +
    `from it, and every instance must derive the same one.`;
  if (env.NODE_ENV === "production") throw new Error(message);
  console.warn(message);
}
