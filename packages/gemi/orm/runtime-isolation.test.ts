import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The ORM runtime executes every query itself: no Prisma query engine, no
// serialization boundary, no Prisma client at runtime. Prisma's *types* are
// wired in through the generated model bases in an app, imported type-only, and
// its runtime never ships in a bundle.
//
// That is a property of the whole directory, not of any one file, so it is
// asserted as one — a single stray `import { PrismaClient } from ...` while
// adding an operation would quietly re-introduce the boundary the project
// exists to remove.

/** Directories with no first-party source in them. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".publish"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(path));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test-d.ts")
    ) {
      // Tests are not runtime code, and this one has to name `@prisma/` to
      // assert against it.
      out.push(path);
    }
  }
  return out;
}

describe("the ORM runtime", () => {
  const files = sourceFiles(import.meta.dirname);

  test("covers the whole directory", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test.each(files.map((file) => [file.slice(import.meta.dirname.length + 1)]))(
    "%s does not reference @prisma/*",
    (relative) => {
      const content = readFileSync(join(import.meta.dirname, relative), "utf8");
      expect(content).not.toMatch(/@prisma\//);
    },
  );
});

// The same property, one directory wider — and this is the half that was not
// being checked.
//
// `app/prismaExtension.ts` value-imported `Prisma` and was re-exported from
// `app/index.ts`, so importing `App` from `gemi/app` — which
// `docs/project-structure.md` documents — pulled the Prisma runtime into the
// graph. `docs/orm.md` states that `@prisma/client` "never appears in a runtime
// import and never ships in a bundle"; that sentence was false for as long as
// the barrel carried the extension, and the check written to prevent exactly
// this walked only `orm/`, so it never had a chance to fire.
//
// It also cost every consumer a dependency: `@prisma/client` sat in gemi's
// `dependencies` for that one import, pulling ~95MB and an 18MB query engine
// into the install graph of a framework that never executes a Prisma query.
// Prisma's types belong to the *app* — its generated model bases import them,
// its `prisma generate` produces them, and its `prisma` CLI must match their
// version — so gemi declaring the package at all is what put a matched pair
// across two manifests.
//
// Hence: gemi's own source imports `@prisma/client` nowhere, and there is no
// directory in which doing so is correct.
const PACKAGE_ROOT = join(import.meta.dirname, "..");

/**
 * Every module specifier `source` pulls in, by any of the four spellings.
 *
 * Deliberately not a plain substring search for the name: `bin/orm/emit.ts`
 * holds `"@prisma/client"` as the default value it writes into the *emitted*
 * models file, and `bin/orm-generator.ts` names it in prose. Both are correct
 * and neither is an import. The generator's own purity — that it never imports
 * the client while emitting an import of it — is asserted separately, in
 * `bin/orm/emit.test.ts`.
 */
function importedModules(source: string): string[] {
  const patterns = [
    // `import … from "x"`, `export … from "x"`, `import "x"`. `[^;]` spans
    // newlines, so multi-line import lists are covered.
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g,
    /(?:^|\n)\s*import\s+"([^"]+)"/g,
    // `import("x")` and `require("x")`.
    /\bimport\(\s*"([^"]+)"\s*\)/g,
    /\brequire\(\s*"([^"]+)"\s*\)/g,
  ];

  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]),
  );
}

describe("the gemi package", () => {
  const files = sourceFiles(PACKAGE_ROOT);

  /**
   * Both halves have to be readable, or the assertion below is a tautology over
   * an empty list. The bound is well under the real count and only has to prove
   * the walk reaches past `orm/` — which is the whole point of this block.
   */
  test("covers more than the ORM directory", () => {
    const ormFiles = sourceFiles(import.meta.dirname);

    expect(files.length).toBeGreaterThan(ormFiles.length);
    expect(
      files.some((file) => file.includes(`${join(PACKAGE_ROOT, "app")}/`)),
      "the walk does not reach app/, where the regression this covers lived",
    ).toBe(true);
  });

  test.each(files.map((file) => [file.slice(PACKAGE_ROOT.length + 1)]))(
    "%s does not import @prisma/client",
    (relative) => {
      const source = readFileSync(join(PACKAGE_ROOT, relative), "utf8");

      expect(
        importedModules(source),
        `${relative} imports @prisma/client. gemi's runtime never needs it: ` +
          `Prisma's types are imported by the app's generated model bases, ` +
          `from the app's own dependency. Adding it back here reinstates the ` +
          `bundle weight and the version skew removing it was meant to end.`,
      ).not.toContain("@prisma/client");
    },
  );
});
