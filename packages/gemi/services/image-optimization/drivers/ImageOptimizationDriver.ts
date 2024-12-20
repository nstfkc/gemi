import type { ResizeParameters } from "./types";

export abstract class ImageOptimizationDriver {
  abstract resize(
    buffer: Buffer,
    parameters: ResizeParameters,
  ): Promise<Buffer>;
}
