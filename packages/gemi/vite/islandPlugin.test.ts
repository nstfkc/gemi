import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { build } from "vite";

import { createIslandResolver } from "../server/modulePreloads";
import { gemiIslandPlugin } from "./islandPlugin";

/**
 * The island plugin against real builds: the client bundle must carry the
 * manifest key the server looks the island up by and an island entry per
 * module, React DOM included; the server bundle must render the component
 * without a dynamic import.
 */

const require = createRequire(import.meta.url);
// The temporary app has no node_modules of its own.
const alias = {
  react: dirname(require.resolve("react/package.json")),
  "react-dom": dirname(require.resolve("react-dom/package.json")),
};

let dir: string;

beforeEach(async () => {
  // Real path: the manifest is keyed relative to the root as Vite sees it.
  dir = await realpath(await mkdtemp(join(tmpdir(), "gemi-island-plugin-")));
  await mkdir(join(dir, "app/site"), { recursive: true });
  // `island` stands in for gemi's: the plugin only cares about the call.
  await writeFile(join(dir, "app/site/island.js"), `export const island = (loader) => loader;\n`);
  await writeFile(
    join(dir, "app/site/page.js"),
    `import { island } from "./island.js";
export const Counter = island(() => import("./Counter.js"), { load: "idle" });
export const Again = island(  () =>import('./Counter.js'));
export default function Page() { return Counter.gemiModule.default(); }
`,
  );
  await writeFile(
    join(dir, "app/site/Counter.js"),
    `export default function Counter() { return "COUNTER_COMPONENT"; }\n`,
  );
  await writeFile(join(dir, "app/site/plain.js"), `export default function Plain() { return "plain"; }\n`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildApp(ssr: boolean, entry = "app/site/page.js") {
  const outDir = join(dir, ssr ? "dist/server" : "dist/client");
  await build({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [gemiIslandPlugin()],
    resolve: { alias },
    build: {
      outDir,
      manifest: true,
      minify: false,
      ssr: ssr ? join(dir, entry) : undefined,
      rollupOptions: ssr
        ? undefined
        : { input: [join(dir, entry)], preserveEntrySignatures: "strict" },
    },
  });
  const files = await readdir(outDir, { recursive: true });
  const code = await Promise.all(
    files.filter((f) => /\.m?js$/.test(f)).map((f) => readFile(join(outDir, f), "utf8")),
  );
  const manifest = JSON.parse(await readFile(join(outDir, ".vite/manifest.json"), "utf8"));
  return { code: code.join("\n"), files, manifest };
}

describe("gemiIslandPlugin", () => {
  test("tags the loader with the module's manifest key and imports the module", async () => {
    const { code } = await buildApp(false);

    // Both spellings of the call were found.
    expect(code.match(/gemiIsland: "app\/site\/Counter.js"/g)).toHaveLength(2);
    expect(code).toMatch(/gemiModule:/);
  });

  test("builds an island entry per module, with React DOM in its closure", async () => {
    const { code, manifest } = await buildApp(false);

    const entry = manifest["app/site/Counter.js?gemi-island"];
    expect(entry.isEntry).toBe(true);
    const counter = createIslandResolver(manifest)("app/site/Counter.js")!;
    expect(counter.src).toBe(`/${entry.file}`);
    expect(counter.preload[0]).toBe(counter.src);
    // The entry is the module plus `h`, and `h` needs react-dom/client: the
    // manifest shows it among the entry's imports, as `gemi stats` reads it.
    const closure = await Promise.all(
      counter.preload.map((url) => readFile(join(dir, "dist/client", url), "utf8")),
    );
    expect(closure.join("\n")).toContain("hydrateRoot");
    expect(closure.join("\n")).toContain("COUNTER_COMPONENT");
    expect(code.match(/hydrateRoot/g)!.length).toBeGreaterThan(0);
    // One entry for the module, however many island() calls name it.
    expect(Object.keys(manifest).filter((key) => key.endsWith("?gemi-island"))).toEqual([
      "app/site/Counter.js?gemi-island",
    ]);
  });

  test("renders the component on the server without a dynamic import", async () => {
    const { code } = await buildApp(true);

    expect(code).toContain(`gemiIsland: "app/site/Counter.js"`);
    expect(code).toContain("COUNTER_COMPONENT");
    expect(code).not.toContain("import(");
    expect(code).not.toContain("hydrateRoot");
  });

  test("adds nothing to a build without islands", async () => {
    const { files, manifest } = await buildApp(false, "app/site/plain.js");

    expect(Object.keys(manifest).some((key) => key.endsWith("?gemi-island"))).toBe(false);
    expect(files.filter((f) => f.endsWith(".js"))).toHaveLength(1);
  });
});
