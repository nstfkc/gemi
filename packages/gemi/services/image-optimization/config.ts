import type { ImageOptimizationDriver } from "./drivers/ImageOptimizationDriver";
import { Sharp } from "./drivers/SharpDriver";

// Config key: `image`.
export interface ImageConfig {
  driver?: ImageOptimizationDriver;
}

export function defineImageConfig(config: ImageConfig): ImageConfig {
  return config;
}

export function imageConfigDefaults(): Required<ImageConfig> {
  return {
    driver: new Sharp(),
  };
}
