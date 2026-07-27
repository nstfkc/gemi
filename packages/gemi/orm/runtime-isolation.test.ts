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
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
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
