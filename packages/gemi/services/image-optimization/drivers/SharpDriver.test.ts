import { describe, expect, test } from "vitest";

import { Storage } from "../../../facades/Storage";
import { loadSharp } from "../../../support/sharp";
import { Sharp } from "./SharpDriver";

/**
 * #1323. gemi's three uses of `sharp`, run against whichever version is
 * installed, so the peer range `^0.34.2 || ^0.35.5` is checked rather than
 * assumed: the resize driver, `Storage.metadata()` and the OG-image path
 * (satori's SVG rasterised to PNG through librsvg).
 */
const svg = (width: number, height: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="#c00"/></svg>`,
  );

describe("sharp integration", () => {
  test("the driver resizes to WebP", async () => {
    const sharp = await loadSharp("test");
    const png = await sharp(svg(400, 200)).png().toBuffer();

    const out = await new Sharp().resize(png, { width: 100, height: 0, quality: 70 });
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(50);
  });

  test("the driver honours fit with both dimensions", async () => {
    const sharp = await loadSharp("test");
    const png = await sharp(svg(400, 200)).png().toBuffer();

    const out = await new Sharp().resize(png, { width: 50, height: 50, fit: "cover" });
    const meta = await sharp(out).metadata();

    expect([meta.width, meta.height]).toEqual([50, 50]);
  });

  test("Storage.metadata reads an image and returns {} for anything else", async () => {
    const sharp = await loadSharp("test");
    const png = await sharp(svg(30, 20)).png().toBuffer();

    const meta = await Storage.metadata(new Blob([new Uint8Array(png)]));
    expect(meta).toMatchObject({ format: "png", width: 30, height: 20 });

    expect(await Storage.metadata(new Blob(["not an image"]))).toEqual({});
  });

  test("an SVG rasterises to PNG with the OG-image options", async () => {
    const sharp = await loadSharp("test");
    const png = await sharp(svg(120, 63)).png({ compressionLevel: 0, effort: 10 }).toBuffer();

    const meta = await sharp(png).metadata();
    expect(meta).toMatchObject({ format: "png", width: 120, height: 63 });
  });
});
