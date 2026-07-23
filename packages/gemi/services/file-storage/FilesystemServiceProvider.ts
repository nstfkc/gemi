import { ServiceProvider } from "../../support/ServiceProvider";
import type { FilesystemConfig } from "./config";
import { FilesystemManager } from "./FilesystemManager";

export class FilesystemServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      FilesystemManager,
      () =>
        new FilesystemManager(
          this.app.config.get<FilesystemConfig>("filesystem", {}),
        ),
    );
  }
}
