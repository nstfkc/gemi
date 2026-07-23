import { ServiceProvider } from "../../support/ServiceProvider";
import type { ImageConfig } from "./config";
import { ImageManager } from "./ImageManager";

export class ImageServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      ImageManager,
      () => new ImageManager(this.app.config.get<ImageConfig>("image", {})),
    );
  }
}
