import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { build } from "vite";

import { createIslandAssets } from "../server/modulePreloads";
import { gemiIslandPlugin } from "./islandPlugin";

/**
 * The island plugin against real builds: the client bundle must carry the
 * manifest key the server looks the island up by, and the server bundle must
 * not carry the island's browser code.
 */

let dir: string;

beforeEach(async () => {
  // Real path: the manifest is keyed relative to the root as Vite sees it.
  dir = await realpath(await mkdtemp(join(tmpdir(), "gemi-island-plugin-")));
  await mkdir(join(dir, "app/site"), { recursive: true });
  // `island` stands in for gemi's: the plugin only cares about the loader.
  await writeFile(
    join(dir, "app/site/page.js"),
    `const island = (name, component, loader) => loader;
export const Menu = island("menu", null, () => import("./menu.island"));
`,
  );
  await writeFile(
    join(dir, "app/site/menu.island.js"),
    `export default function mount(root) { root.dataset.island = "BROWSER_ONLY_CODE"; }\n`,
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildApp(ssr: boolean) {
  const outDir = join(dir, ssr ? "dist/server" : "dist/client");
  await build({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [gemiIslandPlugin()],
    build: {
      outDir,
      manifest: true,
      minify: false,
      ssr: ssr ? join(dir, "app/site/page.js") : undefined,
      rollupOptions: ssr
        ? undefined
        : {
            input: [join(dir, "app/site/page.js"), join(dir, "app/site/menu.island.js")],
            preserveEntrySignatures: "strict",
          },
    },
  });
  const files = await readdir(outDir, { recursive: true });
  const code = await Promise.all(
    files.filter((f) => /\.m?js$/.test(f)).map((f) => readFile(join(outDir, f), "utf8")),
  );
  const manifest = JSON.parse(await readFile(join(outDir, ".vite/manifest.json"), "utf8"));
  return { code: code.join("\n"), manifest };
}

describe("gemiIslandPlugin", () => {
  test("tags the loader with the module's manifest key in the client build", async () => {
    const { code, manifest } = await buildApp(false);

    expect(code).toContain(`gemiIsland: "app/site/menu.island.js"`);
    const assets = createIslandAssets(manifest);
    expect(Object.keys(assets)).toEqual(["app/site/menu.island.js"]);
    expect(assets["app/site/menu.island.js"].src).toMatch(/^\/assets\/.+\.js$/);
    expect(assets["app/site/menu.island.js"].preload[0]).toBe(
      assets["app/site/menu.island.js"].src,
    );
  });

  test("keeps the island's browser code out of the server build", async () => {
    const { code } = await buildApp(true);

    expect(code).toContain(`gemiIsland: "app/site/menu.island.js"`);
    expect(code).not.toContain("BROWSER_ONLY_CODE");
  });
});
