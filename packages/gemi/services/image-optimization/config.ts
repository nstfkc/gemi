import { BunImage } from "./drivers/BunImageDriver";
import type { ImageOptimizationDriver } from "./drivers/ImageOptimizationDriver";

// Config key: `image`.
export interface ImageConfig {
  driver?: ImageOptimizationDriver;
}

export function defineImageConfig(config: ImageConfig): ImageConfig {
  return config;
}

export function imageConfigDefaults(): Required<ImageConfig> {
  return {
    driver: new BunImage(),
  };
}
