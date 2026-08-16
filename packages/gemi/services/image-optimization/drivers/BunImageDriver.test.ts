import { describe, expect, test } from "vitest";

import { BunImage } from "./BunImageDriver";

// A 24-bit BMP is the cheapest raster `Bun.Image` will decode, so the fixture
// needs no binary asset in the tree. 2:1 makes every aspect-ratio assertion
// below unambiguous.
function makeBmp(width: number, height: number) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const bmp = Buffer.alloc(54 + pixelBytes);

  bmp.write("BM", 0);
  bmp.writeUInt32LE(54 + pixelBytes, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelBytes, 34);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 54 + y * rowSize + x * 3;
      bmp[offset] = (x * 255) / width;
      bmp[offset + 1] = (y * 255) / height;
      bmp[offset + 2] = 128;
    }
  }

  return bmp;
}

const source = makeBmp(200, 100);
const driver = new BunImage();

async function resize(parameters: Parameters<BunImage["resize"]>[1]) {
  const out = await driver.resize(source, parameters);
  return { out, ...(await new Bun.Image(out).metadata()) };
}

describe("resize", () => {
  test("always encodes WebP, whatever the source format was", async () => {
    expect((await resize({ width: 50, height: 0 })).format).toBe("webp");
    expect((await resize({ width: 0, height: 0 })).format).toBe("webp");
  });

  test("preserves the aspect ratio when only a width is given", async () => {
    // The `<Image>` component only ever sends `w`, so this is the hot path.
    const { width, height } = await resize({ width: 50, height: 0 });

    expect([width, height]).toEqual([50, 25]);
  });

  test("preserves the aspect ratio when only a height is given", async () => {
    // `Bun.Image.resize()` requires a width, so the driver derives one from the
    // source ratio rather than passing the height through alone.
    const { width, height } = await resize({ width: 0, height: 50 });

    expect([width, height]).toEqual([100, 50]);
  });

  test("re-encodes at source size when neither dimension is given", async () => {
    const { width, height } = await resize({ width: 0, height: 0 });

    expect([width, height]).toEqual([200, 100]);
  });

  test("treats negative dimensions as unconstrained", async () => {
    const { width, height } = await resize({ width: 50, height: -1 });

    expect([width, height]).toEqual([50, 25]);
  });
});

describe("fit", () => {
  // `Bun.Image` has no crop primitive, so the cropping fits collapse onto
  // `fill`. Locked in here because the mapping is lossy and silent.
  test.each([
    ["cover", 50, 50],
    ["fill", 50, 50],
    ["outside", 50, 50],
    ["contain", 50, 25],
    ["inside", 50, 25],
  ] as const)("%s produces %ix%i", async (fit, expectedW, expectedH) => {
    const { width, height } = await resize({ width: 50, height: 50, fit });

    expect([width, height]).toEqual([expectedW, expectedH]);
  });

  test("defaults to cover when omitted, matching the resize route", async () => {
    const { width, height } = await resize({ width: 50, height: 50 });

    expect([width, height]).toEqual([50, 50]);
  });

  test("is inert when only one dimension is constrained", async () => {
    const cover = await resize({ width: 50, height: 0, fit: "cover" });
    const inside = await resize({ width: 50, height: 0, fit: "inside" });

    expect([cover.width, cover.height]).toEqual([50, 25]);
    expect([inside.width, inside.height]).toEqual([50, 25]);
  });
});

describe("quality", () => {
  test("falls back to 80 when unset or zero", async () => {
    const unset = await resize({ width: 50, height: 0 });
    const zero = await resize({ width: 50, height: 0, quality: 0 });

    expect(zero.out.byteLength).toBe(unset.out.byteLength);
  });

  test("a lower quality yields fewer bytes", async () => {
    const low = await resize({ width: 50, height: 0, quality: 30 });
    const high = await resize({ width: 50, height: 0, quality: 95 });

    expect(low.out.byteLength).toBeLessThan(high.out.byteLength);
  });
});

test("returns a Buffer, as the driver contract requires", async () => {
  const out = await driver.resize(source, { width: 50, height: 0 });

  expect(Buffer.isBuffer(out)).toBe(true);
});

test("rejects bytes that are not a decodable image", async () => {
  await expect(
    driver.resize(Buffer.from([1, 2, 3]), { width: 50, height: 0 }),
  ).rejects.toThrow();
});
