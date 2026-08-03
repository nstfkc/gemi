import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every subpath in the package's `exports` map, checked against the file it
 * names — in both the form apps consume and the form npm publishes.
 *
 * `"./runtime": "./client/runtime.ts"` outlived its target by more than a year.
 * `client/runtime.ts` was deleted in June 2024 (`18057af`, "vite doesn't build
 * client") and the entry stayed, so `import "gemi/runtime"` resolved to nothing
 * in the repo and, because `dist/runtime/index.js` is not emitted either, to
 * nothing in the tarball. The published `0.51.0-rc.1` carries
 * `dist/runtime/index.d.ts` and no `.js` beside it: types for a module that
 * cannot be loaded.
 *
 * What kept it alive is worth recording, because it is the part a test fixes.
 * `build-publish.ts` held an override mapping the entry to a built path,
 * introduced to avoid "changing the published surface" — but the built path was
 * as absent as the source, so the override did not preserve a working export,
 * it made a broken one look deliberate. A comment asserting the mapping was
 * fine is exactly what a check would have contradicted.
 *
 * Two assertions, because the two maps fail differently: the dev map is what
 * breaks `bun run dev` in this repo, and the published map is what breaks
 * `npm install gemi`. The published one is only checkable after a build, so it
 * is verified structurally here and by `npm pack` at release time.
 */
const ROOT = join(import.meta.dirname);

const PKG: { exports: Record<string, unknown> } = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
);

const entries = Object.entries(PKG.exports).filter(
  (entry): entry is [string, string] => typeof entry[1] === "string",
);

describe("the package's exports map", () => {
  test("names at least the entrypoints the docs and templates import", () => {
    // Guards against an `exports` that parsed to something empty, which would
    // make every assertion below vacuously true.
    expect(entries.length).toBeGreaterThan(15);
  });

  test("every source target exists", () => {
    // `./dist/…` targets are build output, absent until `bun run build` — they
    // are covered by the publish-shape test below instead.
    const dangling = entries
      .filter(([, target]) => !target.startsWith("./dist/"))
      .filter(([, target]) => !existsSync(join(ROOT, target)))
      .map(([subpath, target]) => `${subpath} -> ${target}`);

    expect(dangling).toEqual([]);
  });

  test("every published target is a built path", () => {
    // The publish map is derived by rewriting `./x.ts` to `./dist/x.js`, so a
    // source entry that is not a `.ts`/`.tsx` file silently publishes a target
    // that was never compiled — the shape of the bug this file exists for.
    const unbuildable = entries
      .filter(([, target]) => !target.startsWith("./dist/"))
      .filter(([, target]) => !/\.tsx?$/.test(target))
      .map(([subpath, target]) => `${subpath} -> ${target}`);

    expect(unbuildable).toEqual([]);
  });
});
