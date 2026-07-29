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

  /**
   * **Invariant 6: the generated files hold data and strings, with no import
   * graph.**
   *
   * `plans/orm/README.md`: the generated schema references relations by model
   * *name*, and the registry resolves name to class at call time, never at
   * module load. Without that, `User.ts` imports `Post.ts` imports `User.ts`,
   * and under ESM one of them is `undefined` during module evaluation — the
   * classic ORM bootstrap failure, which appears the moment two models
   * reference each other.
   *
   * The invariant is preserved by the *generator*, so the artifact is where it
   * has to be asserted. It is also the kind of thing that would be broken by an
   * obvious-looking improvement: emitting `import { PostModel } from "./Post"`
   * beside a relation reads as more type-safe and reintroduces the cycle.
   */
  describe("the artifact has no import graph", () => {
    const source = (file: string) => readFileSync(join(GENERATED, file), "utf8");
    const importsOf = (file: string) =>
      [...source(file).matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)].map(
        (match) => ({ typeOnly: Boolean(match[1]), from: match[2] }),
      );

    /**
     * The schema is the data half, and it is the one that carries relations —
     * so it is the file a cycle would appear in first. Types only: erased at
     * build, no runtime edge.
     */
    test("schema.ts imports nothing at runtime", () => {
      const runtime = importsOf("schema.ts").filter((entry) => !entry.typeOnly);
      expect(runtime).toEqual([]);
    });

    /** ...and it names its relation targets as strings rather than values. */
    test("schema.ts references models by name", () => {
      const schema = source("schema.ts");

      // Emitted as JSON, so the key is quoted — matched either way so a
      // change of emitter style does not read as a broken invariant.
      expect(schema).toMatch(/"?model"?:\s*"User"/);
      expect(schema).toMatch(/"?model"?:\s*"Post"/);
      // A relation naming a *class* rather than a string would be the cycle
      // arriving: `"model": UserModel` instead of `"model": "User"`.
      expect(schema).not.toMatch(/"?model"?:\s*[A-Za-z_$]/);
    });

    /**
     * No generated file may import another model's module. `models.ts` holding
     * every class in one file is what makes that easy — and is itself part of
     * the answer, since eleven separate files would each need the others.
     */
    test("no generated file imports a model module", () => {
      for (const file of FILES) {
        const local = importsOf(file)
          .map((entry) => entry.from)
          .filter((from) => from.startsWith("."));

        // `./schema` and `./models` only — never a per-model module.
        expect(local.sort(), `${file} imports ${local.join(", ")}`).toEqual(
          local.filter((from) => from === "./schema" || from === "./models").sort(),
        );
      }
    });

    /**
     * Registration is by name and happens in `index.ts`, once, for every model
     * — so importing the generated index is the whole bootstrap.
     */
    test("every model class is registered by name", () => {
      const models = source("models.ts");
      const index = source("index.ts");

      const declared = [...models.matchAll(/^export class (\w+)Model\b/gm)].map(
        (match) => match[1],
      );
      expect(declared.length).toBeGreaterThan(5);

      for (const name of declared) {
        expect(index, `${name} is declared but never registered`).toContain(
          `register("${name}", ${name}Model)`,
        );
      }
    });
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
