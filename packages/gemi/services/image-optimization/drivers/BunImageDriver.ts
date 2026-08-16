import { ImageOptimizationDriver } from "./ImageOptimizationDriver";
import type { FitEnum, ResizeParameters } from "./types";

// `Bun.Image` resizes with `fill` (stretch to exactly width×height) or
// `inside` (shrink to fit within the box, aspect preserved). It has no crop
// primitive, so sharp's `cover`/`outside` — which fill the box and discard the
// overflow — have no faithful equivalent. They map to `fill`, which honours the
// requested dimensions at the cost of distorting the aspect ratio. `contain`
// maps to `inside`, which is the same fit without the letterbox padding.
//
// This only bites when *both* `w` and `h` are given: with one dimension the
// aspect ratio is preserved either way and `fit` is inert. The built-in
// `<Image>` component only ever sends `w`, so it never reaches this table.
const FIT: Record<keyof FitEnum, "fill" | "inside"> = {
  cover: "fill",
  fill: "fill",
  outside: "fill",
  contain: "inside",
  inside: "inside",
};

export class BunImage extends ImageOptimizationDriver {
  async resize(buffer: Buffer, parameters: ResizeParameters) {
    const { height, width, quality, fit } = parameters;

    const image = new Bun.Image(buffer);
    const targetWidth = width > 0 ? width : 0;
    const targetHeight = height > 0 ? height : 0;

    if (targetWidth > 0 && targetHeight > 0) {
      image.resize(targetWidth, targetHeight, { fit: FIT[fit ?? "cover"] });
    } else if (targetWidth > 0) {
      image.resize(targetWidth);
    } else if (targetHeight > 0) {
      // `resize()` requires a width, so derive one from the source aspect
      // ratio to get sharp's height-only behaviour. `metadata()` only decodes
      // the header, so this costs a header parse rather than a second decode.
      const source = await new Bun.Image(buffer).metadata();
      const scaled = Math.max(
        1,
        Math.round((source.width * targetHeight) / source.height),
      );
      image.resize(scaled, targetHeight, { fit: "fill" });
    }

    return await image.webp({ quality: quality > 0 ? quality : 80 }).toBuffer();
  }
}
