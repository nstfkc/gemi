import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The two compilations that must not be confused, asserted on the configs rather
 * than on their output.
 *
 * `tsconfig.json` is what checks the type tests: `vitest --typecheck` spawns a
 * bare `tsc --noEmit` with its cwd in this package and no `-p`, so it resolves
 * that file and honours its `exclude`. `tsconfig.build.json` is what emits
 * `dist/`, and it excludes the type tests because a `*.test-d.d.ts` that
 * `declare module`s a consumer's `RPC` puts phantom routes on it.
 *
 * Swapping those two is a one-line edit that looks like a tidy-up and has no
 * failing test anywhere else:
 *
 * - The exclusion in `tsconfig.build.json`, removed: `dist/` carries the type
 *   declarations again. `packaging.test.ts` catches that one, on the real tarball.
 * - The exclusion in `tsconfig.json`, added: the type tests stop being compiled
 *   and report green while checking nothing. Measured — with it there, a planted
 *   `const x: number = "s"` in a `*.test-d.ts` is not reported and the run says
 *   "114 passed, no errors". That is what this file is for, because a suite that
 *   passes vacuously cannot fail to say so.
 */

const PACKAGE = import.meta.dirname;

/** Whole-line `//` comments only, which is all these two files use. */
async function config(file: string): Promise<{ exclude: string[] }> {
  const raw = await Bun.file(path.join(PACKAGE, file)).text();
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  if (/\S\s*\/\//.test(stripped)) {
    throw new Error(`${file} has a trailing // comment, which this stripper does not handle`);
  }
  return JSON.parse(stripped);
}

const isTypeTest = (pattern: string) => pattern.includes("test-d");

describe("the declaration build and the type check stay apart", () => {
  test("tsconfig.json excludes no type test, or the suite checks nothing", async () => {
    const { exclude } = await config("tsconfig.json");

    expect(
      exclude.filter(isTypeTest),
      "excluding *.test-d from tsconfig.json makes `vitest --typecheck` vacuous — " +
        "it belongs in tsconfig.build.json, which is the emit config",
    ).toEqual([]);
  });

  test("tsconfig.build.json excludes every type test, or dist ships them", async () => {
    const { exclude } = await config("tsconfig.build.json");

    expect(exclude).toContain("**/*.test-d.ts");
    expect(exclude).toContain("**/*.test-d.tsx");
  });

  test("and everything tsconfig.json excludes, since exclude replaces rather than extends", async () => {
    // The trap that makes the split cost something: `tsconfig.build.json`
    // extends `tsconfig.json`, but a child's `exclude` REPLACES the parent's. A
    // new entry added above is silently not excluded from the emit.
    const parent = await config("tsconfig.json");
    const child = await config("tsconfig.build.json");

    expect(
      parent.exclude.filter((entry) => !child.exclude.includes(entry)),
      "tsconfig.json excludes something tsconfig.build.json does not — copy it down",
    ).toEqual([]);
  });

  test("build:types is the one that uses the emit config", async () => {
    const manifest = await Bun.file(path.join(PACKAGE, "package.json")).json();

    expect(manifest.scripts["build:types"]).toBe("tsc -p tsconfig.build.json");
    // And the check runs the one that sees the tests.
    expect(manifest.scripts.typecheck).toContain("-p tsconfig.json");
  });
});
