import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  ASSET_BASE_RECORD,
  assetUrl,
  normalizeAssetBase,
  readBuiltAssetBase,
  resolveAssetBase,
} from "./assetBase";

describe("normalizeAssetBase", () => {
  test("is `/` when unset or blank", () => {
    expect(normalizeAssetBase(undefined)).toBe("/");
    expect(normalizeAssetBase("")).toBe("/");
    expect(normalizeAssetBase("  ")).toBe("/");
  });

  test("ends in exactly one `/` whichever way it was written", () => {
    expect(normalizeAssetBase("https://cdn.example.com/r42")).toBe("https://cdn.example.com/r42/");
    expect(normalizeAssetBase("https://cdn.example.com/r42/")).toBe("https://cdn.example.com/r42/");
    expect(normalizeAssetBase("/static")).toBe("/static/");
    expect(normalizeAssetBase("/")).toBe("/");
  });

  test("refuses a relative base", () => {
    // Resolved against each page's URL by the document, so `/users/7` would
    // link `/users/assets/...`.
    for (const value of ["./", "static/", "cdn.example.com/r42"]) {
      expect(() => normalizeAssetBase(value), value).toThrow(/absolute URL/);
    }
  });
});

describe("resolveAssetBase", () => {
  test("is undefined when neither the variable nor the config sets one", () => {
    // Undefined, not `/`: the plugin then leaves Vite's `base` alone, and an
    // app that set `vite.base` itself keeps it.
    expect(resolveAssetBase(undefined, undefined)).toBeUndefined();
    expect(resolveAssetBase("", "")).toBeUndefined();
  });

  test("takes the config's value", () => {
    expect(resolveAssetBase("https://cdn.example.com/a", undefined)).toBe(
      "https://cdn.example.com/a/",
    );
  });

  test("lets GEMI_ASSET_BASE win over the config", () => {
    expect(resolveAssetBase("https://cdn.example.com/a", "https://cdn.example.com/b")).toBe(
      "https://cdn.example.com/b/",
    );
  });
});

describe("assetUrl", () => {
  test("is root-relative by default", () => {
    expect(assetUrl("assets/client-abc.js")).toBe("/assets/client-abc.js");
  });

  test("prefixes the base", () => {
    expect(assetUrl("assets/client-abc.js", "https://cdn.example.com/r42/")).toBe(
      "https://cdn.example.com/r42/assets/client-abc.js",
    );
  });
});

describe("readBuiltAssetBase", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("is `/` for a build with no record", async () => {
    dir = await mkdtemp(join(tmpdir(), "gemi-asset-base-"));
    expect(await readBuiltAssetBase(dir)).toBe("/");
  });

  test("is what the build recorded, not what the environment says now", async () => {
    dir = await mkdtemp(join(tmpdir(), "gemi-asset-base-"));
    await mkdir(join(dir, ".vite"));
    await writeFile(
      join(dir, ASSET_BASE_RECORD),
      JSON.stringify({ assetBase: "https://cdn.example.com/r42/" }),
    );

    const previous = process.env.GEMI_ASSET_BASE;
    process.env.GEMI_ASSET_BASE = "https://cdn.example.com/other/";
    try {
      expect(await readBuiltAssetBase(dir)).toBe("https://cdn.example.com/r42/");
    } finally {
      if (previous === undefined) delete process.env.GEMI_ASSET_BASE;
      else process.env.GEMI_ASSET_BASE = previous;
    }
  });
});
