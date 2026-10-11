import { ServiceProvider } from "../../support/ServiceProvider";
import type { RunsConfig } from "./config";
import { RunManager } from "./RunManager";

export class RunsServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      RunManager,
      () =>
        new RunManager(this.app.config.get<RunsConfig>("runs", {}), {
          application: this.app,
        }),
    );
  }
}
