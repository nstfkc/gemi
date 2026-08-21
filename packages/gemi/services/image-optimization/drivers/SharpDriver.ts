import { ImageOptimizationDriver } from "./ImageOptimizationDriver";
import { loadSharp } from "../../../support/sharp";
import type { ResizeParameters } from "./types";

export class Sharp extends ImageOptimizationDriver {
  async resize(buffer: Buffer, parameters: ResizeParameters) {
    const { height, width, quality, fit } = parameters;
    const sharp = await loadSharp("The Sharp image optimization driver");
    return await sharp(buffer)
      .resize(width > 0 ? width : undefined, height > 0 ? height : undefined, {
        fit,
      })
      .webp({ quality: quality > 0 ? quality : 80, force: true })
      .toBuffer();
  }
}
