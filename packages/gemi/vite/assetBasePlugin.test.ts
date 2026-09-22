import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { build, type Plugin } from "vite";

import { ASSET_BASE_RECORD, readBuiltAssetBase } from "../config/assetBase";
import { gemiAssetBasePlugin } from "./assetBasePlugin";
import gemi from "./index";

/**
 * The invariant: the document `httpProd` renders and the bundle the browser
 * runs name the same base. So these build a real bundle and read back both
 * halves — the URLs Vite baked into it, and the record the server reads.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemi-asset-base-build-"));
  await writeFile(join(dir, "main.js"), `import("./lazy.js").then((m) => m.run());\n`);
  // A lazy chunk with its own CSS is what makes Vite emit its preload helper,
  // and the CSS `url()` is the other place the bundle spells out the base.
  await writeFile(join(dir, "lazy.js"), `import "./lazy.css";\nexport const run = () => 1;\n`);
  await writeFile(join(dir, "lazy.css"), `body { background: url(./bg.png); }\n`);
  await writeFile(join(dir, "bg.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildFixture(plugins: Plugin[], options: { ssr?: boolean; base?: string } = {}) {
  const outDir = join(dir, options.ssr ? "dist/server" : "dist/client");
  await build({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins,
    ...(options.base !== undefined ? { base: options.base } : {}),
    build: {
      outDir,
      manifest: true,
      assetsInlineLimit: 0,
      ...(options.ssr ? { ssr: join(dir, "main.js") } : {}),
      rollupOptions: { input: join(dir, "main.js") },
    },
  });
  return outDir;
}

async function readAssets(outDir: string, extension: string) {
  const files = (await readdir(join(outDir, "assets"))).filter((file) => file.endsWith(extension));
  return (
    await Promise.all(files.map((file) => readFile(join(outDir, "assets", file), "utf8")))
  ).join("\n");
}

describe("gemiAssetBasePlugin", () => {
  test("builds the bundle against the base and records the same base", async () => {
    const outDir = await buildFixture([gemiAssetBasePlugin("https://cdn.example.com/r42/")]);

    // Vite's preload helper (`return "<base>" + dep`) and the CSS `url()` —
    // the URLs the browser resolves from inside the bundle, which the document
    // never sees.
    expect(await readAssets(outDir, ".js")).toMatch(
      /return\s*["'`]https:\/\/cdn\.example\.com\/r42\/["'`]\s*\+/,
    );
    expect(await readAssets(outDir, ".css")).toMatch(
      /url\(https:\/\/cdn\.example\.com\/r42\/assets\/bg-[\w-]+\.png\)/,
    );
    expect(await readBuiltAssetBase(outDir)).toBe("https://cdn.example.com/r42/");
  });

  test("records `/` for a build without a base, which leaves the bundle root-relative", async () => {
    const outDir = await buildFixture([gemiAssetBasePlugin(undefined)]);

    expect(await readAssets(outDir, ".css")).toMatch(/url\(\/assets\/bg-[\w-]+\.png\)/);
    expect(JSON.parse(await readFile(join(outDir, ASSET_BASE_RECORD), "utf8"))).toEqual({
      assetBase: "/",
    });
  });

  test("records the base Vite resolved when it came from `vite.base` instead", async () => {
    // A raw `vite.base` in `gemi.config.ts` reaches the bundle too. Recording
    // the plugin's own input would put the document back on `/` while the
    // bundle loads from the CDN — the disagreement #548 is about.
    const outDir = await buildFixture([gemiAssetBasePlugin(undefined)], {
      base: "https://cdn.example.com/from-vite",
    });

    expect(await readBuiltAssetBase(outDir)).toBe("https://cdn.example.com/from-vite/");
  });

  test("writes no record from the SSR build", async () => {
    const outDir = await buildFixture([gemiAssetBasePlugin("https://cdn.example.com/r42/")], {
      ssr: true,
    });

    expect(existsSync(join(outDir, ASSET_BASE_RECORD))).toBe(false);
  });

  test("leaves the dev server's base alone", () => {
    const plugin = gemiAssetBasePlugin("https://cdn.example.com/r42/");
    const config = plugin.config as (config: object, env: { command: string }) => unknown;

    expect(config({}, { command: "serve" })).toBeUndefined();
    expect(config({}, { command: "build" })).toEqual({ base: "https://cdn.example.com/r42/" });
  });
});

describe("gemi()", () => {
  const previous = process.env.GEMI_ASSET_BASE;

  afterEach(() => {
    if (previous === undefined) delete process.env.GEMI_ASSET_BASE;
    else process.env.GEMI_ASSET_BASE = previous;
  });

  async function assetBasePlugin() {
    const plugins = (await gemi()) as Plugin[];
    const index = plugins.findIndex((plugin) => plugin?.name === "gemi-plugin-asset-base");
    expect(index).toBeGreaterThan(
      plugins.findIndex((plugin) => plugin?.name === "gemi-plugin-user-config"),
    );
    return plugins[index].config as (config: object, env: { command: string }) => unknown;
  }

  test("hands GEMI_ASSET_BASE to the build, normalised", async () => {
    process.env.GEMI_ASSET_BASE = "https://cdn.example.com/r42";

    expect((await assetBasePlugin())({}, { command: "build" })).toEqual({
      base: "https://cdn.example.com/r42/",
    });
  });

  test("sets no base when nothing asks for one", async () => {
    delete process.env.GEMI_ASSET_BASE;

    expect((await assetBasePlugin())({}, { command: "build" })).toBeUndefined();
  });

  test("fails on a relative base before anything is built", async () => {
    process.env.GEMI_ASSET_BASE = "./";

    await expect(gemi()).rejects.toThrow(/absolute URL/);
  });
});
