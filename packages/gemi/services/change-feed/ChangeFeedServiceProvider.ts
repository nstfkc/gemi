import { ServiceProvider } from "../../support/ServiceProvider";
import type { ChangeFeedConfig } from "./config";
import { ChangeFeedManager } from "./ChangeFeedManager";

export class ChangeFeedServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      ChangeFeedManager,
      () =>
        new ChangeFeedManager(this.app.config.get<ChangeFeedConfig>("changeFeed", {}), {
          application: this.app,
        }),
    );
  }

  /**
   * Ends every subscription and closes the `LISTEN` connection. Streams have
   * already ended by then: each stops at its next keepalive once the server
   * starts shutting down, so the request drain does not wait on them.
   */
  async shutdown() {
    if (!this.app.resolved(ChangeFeedManager)) return;
    await this.app.make(ChangeFeedManager).close();
  }
}
