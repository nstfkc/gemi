import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A template suite loads a Prisma client at collection time only if it uses one.
 *
 * **The cost this exists to keep off the collection phase.** `differential.ts`
 * imports `@prisma/client` at module scope — it has to; it *is* the harness that
 * compares against Prisma. It also used to export `POSTGRES_URL`, which is
 *
 *     export const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
 *
 * and `applyMigrations`, which needs `bun`'s `SQL` and two node builtins. Eleven
 * of the thirteen suites that imported the module wanted only those two things,
 * so eleven workers loaded a query engine, before any `describe` ran, to read an
 * environment variable. Both now live in `app/models/scratch.ts`, whose import
 * list is `bun`, `node:fs`, `node:path`.
 *
 * **Why it is asserted rather than left to reviewers.** The regression is
 * invisible: adding `POSTGRES_URL` to an existing `./differential` import is one
 * word in a diff, nothing fails, and the suite is a little slower to collect. It
 * is also the kind of edit an author makes for a good local reason — the symbol
 * is right there in a module they already import.
 *
 * **The failure it removes a suspect for is #217**, where
 * `relations.many-to-many.test.ts` intermittently fails *collection* in the
 * SQLite job. That the failure is at import rather than in `beforeAll` is
 * measurable from the run's own counts rather than inferred from vitest's
 * formatting — injecting each shape into that file and running the directory:
 *
 *     a hook that times out    625 passed | 47 skipped (672)
 *     a module that throws     625 passed | 32 skipped (657)
 *
 * A failed hook still contributes the file's 15 tests, as *skipped*. A module
 * that throws leaves them absent and the total short. #217 reports
 * `605 passed | 32 skipped (637)`, so it is the second, and the 60s hook timeout
 * that reads as the obvious suspect is not the mechanism.
 *
 * This does not claim to be that bug's cause; it has never been reproduced, and
 * a check that passes today would have passed the day it happened. It makes the
 * import surface where such a failure can live smaller, and keeps it that way.
 */
const MODELS = join(
  import.meta.dirname,
  "../../../templates/saas-starter/app/models",
);

/** The module whose import pulls in a Prisma client, and what earns importing it. */
const HARNESS = "./differential";
const HARNESS_API = "createDifferential";

/**
 * Where that client now comes from.
 *
 * `@prisma/client` until the generated bases stopped type-importing Prisma:
 * `prisma/schema.prisma` has no `generator client` block any more, so an app
 * installs `prisma` alone, and the harness generates its own client from
 * `prisma/differential.prisma` into this path instead. The cost this file exists
 * to keep off the collection phase is unchanged — it is still a whole query
 * engine loaded at import.
 */
const CLIENT = "./prisma-client";

const suites = readdirSync(MODELS)
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => ({ file, source: readFileSync(join(MODELS, file), "utf8") }));

describe("the template's model suites", () => {
  /**
   * Both halves of the comparison have to be readable. A rename that made the
   * regex match nothing would turn every assertion below into a tautology, which
   * is precisely how a check that has stopped checking looks from the outside.
   */
  test("the suites were found", () => {
    expect(suites.length).toBeGreaterThan(10);
    expect(
      suites.filter(({ source }) => source.includes(`from "${HARNESS}"`)).length,
      `no suite imports ${HARNESS} — has it been renamed?`,
    ).toBeGreaterThan(0);
  });

  test(`${HARNESS} still imports a Prisma client, which is why this test exists`, () => {
    const source = readFileSync(join(MODELS, "differential.ts"), "utf8");
    // Every regex metacharacter, not just the first `.`: a string pattern
    // replaces one occurrence, so `./prisma-client/index` would have kept an
    // unescaped `.` — which matches any character and leaves the test passing
    // for the wrong reason.
    const literal = CLIENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(source).toMatch(new RegExp(`^import .*from "${literal}";$`, "m"));
  });

  test.each(suites.map(({ file, source }) => [file, source] as const))(
    "%s imports the differential harness only to use it",
    (file, source) => {
      if (!source.includes(`from "${HARNESS}"`)) return;

      expect(
        source.includes(HARNESS_API),
        `${file} imports ${HARNESS} but never calls ${HARNESS_API}, so it pays ` +
          `for a Prisma client at collection time and gets nothing for it. ` +
          `POSTGRES_URL and applyMigrations live in ./scratch.`,
      ).toBe(true);
    },
  );

  /**
   * The other direction: `scratch.ts` is only worth having if it stays cheap, and
   * one import of the harness from it would put every suite back where it was
   * while leaving every assertion above green.
   */
  test("scratch.ts pulls in nothing a suite would not want at import", () => {
    const source = readFileSync(join(MODELS, "scratch.ts"), "utf8");
    const imported = [...source.matchAll(/^import .*from "([^"]+)";$/gm)].map(
      (match) => match[1],
    );

    expect(imported.sort()).toEqual(["bun", "node:fs", "node:path"]);
  });
});
