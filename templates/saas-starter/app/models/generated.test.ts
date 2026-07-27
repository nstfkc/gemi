import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Generation is a Prisma generator block, not a `gemi` subcommand: gemi must
// not shadow or wrap the Prisma CLI. `prisma generate` emits both the Prisma
// client and the gemi artifacts, and every `prisma migrate dev` refreshes them
// with no extra step.
//
// The output is committed, so it has to be stable: if a second run of an
// unchanged schema produced a different byte, every migration would show up in
// review as codegen noise.
const ROOT = join(import.meta.dirname, "../..");
const GENERATED = join(ROOT, "app/models/generated");
const FILES = ["schema.ts", "models.ts", "index.ts"];

function snapshot(): Record<string, string> {
  return Object.fromEntries(
    FILES.map((file) => [file, readFileSync(join(GENERATED, file), "utf8")]),
  );
}

describe("the gemi ORM generator", () => {
  test("emits the three artifacts", () => {
    for (const file of FILES) {
      expect(existsSync(join(GENERATED, file))).toBe(true);
    }
  });

  test(
    "running prisma generate again produces a zero-line diff",
    { timeout: 120_000 },
    () => {
      // The generator is resolved by bin name from node_modules/.bin, and in
      // this repo that symlink points at the built output. Say so plainly
      // rather than failing inside the Prisma CLI.
      const bin = join(ROOT, "node_modules/.bin/gemi-orm-generator");
      expect(
        existsSync(bin),
        "gemi-orm-generator is not linked. Run `bun install`, and " +
          "`bun run build:bin` in packages/gemi.",
      ).toBe(true);

      const before = snapshot();
      execFileSync("bunx", ["prisma", "generate"], {
        cwd: ROOT,
        stdio: "pipe",
      });

      expect(snapshot()).toEqual(before);
    },
  );
});
