import { ServiceProvider } from "../../support/ServiceProvider";
import type { QueueConfig } from "./config";
import { QueueManager } from "./QueueManager";

export class QueueServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      QueueManager,
      () => new QueueManager(this.app.config.get<QueueConfig>("queue", {})),
    );
  }
}
