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
 * **This file checks the source half only, and cannot check the other.** The
 * published targets are `./dist/…` paths that do not exist until `bun run build`
 * runs, so the assertion that every *published* export names a built file lives
 * at the end of `scripts/build-publish.ts`, where a real `dist/` exists. That is
 * the check that would have caught `./runtime`; this one catches the source
 * entry that produced it, one step earlier. Neither subsumes the other:
 * `./client` and `./vite` are emitted by two separate vite configs that
 * `scripts/build.ts` does not cover, so a published target can go missing with
 * every source path in this file still valid.
 */
const ROOT = import.meta.dirname;

const PKG: { exports: Record<string, unknown> } = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
);

const entries = Object.entries(PKG.exports).filter(
  (entry): entry is [string, string] => typeof entry[1] === "string",
);

describe("the package's exports map", () => {
  test("names at least the entrypoints the docs and templates import", () => {
    // Guards against an `exports` that parsed to something empty, which would
    // make every assertion below vacuously true. Pinned just under the 19 the
    // map currently holds, so losing a couple is noticed rather than absorbed.
    expect(entries.length).toBeGreaterThanOrEqual(18);
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

  test("every source target is a file the publish rewrite can compile", () => {
    // `toPublishExports` turns `./x.ts` into `./dist/x.js` by string rewrite. A
    // source entry that is neither already-built nor a `.ts`/`.tsx` file comes
    // out of that rewrite unchanged and publishes a path nothing emits.
    //
    // Note what this does *not* cover: an entry that is already `./dist/…` is
    // skipped here by construction, and that is the shape `./runtime`'s
    // published target had. Only `build-publish.ts` can check those, against a
    // real build.
    const unbuildable = entries
      .filter(([, target]) => !target.startsWith("./dist/"))
      .filter(([, target]) => !/\.tsx?$/.test(target))
      .map(([subpath, target]) => `${subpath} -> ${target}`);

    expect(unbuildable).toEqual([]);
  });
});
