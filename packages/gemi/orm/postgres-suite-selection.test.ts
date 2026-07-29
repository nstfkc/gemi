import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every Postgres-gated suite is named so CI's filter selects it.
 *
 * The Postgres job runs `vitest run app/models --no-file-parallelism -t
 * postgres`. The filter is not tidiness — without it the job fails, because the
 * harness refuses the dialect its Prisma client was not generated for. But `-t`
 * matches on the test's full name, and it is **case-sensitive**, so a
 * Postgres-only suite whose name does not contain the exact string `postgres`
 * is selected by nothing.
 *
 * Three files were in that position, and because they gate themselves with
 *
 *     const RUN = POSTGRES_URL ? describe : describe.skip;
 *
 * they were skipped in the SQLite job too — for want of a URL there, and for
 * want of a matching name here. 24 tests ran in neither:
 *
 *     lateral.test.ts             13   "lateral vs batched, on Postgres"
 *                                      "strategy selection"
 *     lateral.coercion.test.ts     7   "every scalar through a relation, …"
 *     redact-strategies.test.ts    4   "redact on a nested model, both …"
 *
 * Eight of those were missed by a capital P alone. `-t postgres` collected 0
 * tests from `lateral.test.ts`; `-t Postgres` collected 8.
 *
 * The cost was concentrated: two of the three files are the `LATERAL` +
 * `json_agg` strategy, which is Postgres-only and the *default* there, and
 * whose acceptance criterion in `plans/orm/README.md` is that the full nested
 * differential matrix runs against it. It ran nowhere.
 *
 * The suites that do run announce their absence — "⚠ Postgres differential
 * tests did NOT run. Set TEST_POSTGRES_URL". A `describe.skip` says nothing, so
 * these three were silent in exactly the way that mechanism exists to prevent.
 */
const MODELS = join(import.meta.dirname, "../../../templates/saas-starter/app/models");
const WORKFLOW = join(import.meta.dirname, "../../../.github/workflows/ci.yml");

const workflow = readFileSync(WORKFLOW, "utf8");

/**
 * The exact string the Postgres job filters on, read from the workflow rather
 * than assumed — if the job changes filter, this test should follow it or fail,
 * not keep checking a word nobody greps for any more.
 */
const filter = (() => {
  const match = workflow.match(/vitest run app\/models[^\n]*-t (\S+)/);
  expect(match, "the Postgres job's -t filter was not found").not.toBeNull();
  return match![1];
})();

/** Files that gate a suite behind `POSTGRES_URL`, and the suite names they use. */
const gated = readdirSync(MODELS)
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => ({ file, source: readFileSync(join(MODELS, file), "utf8") }))
  .filter(({ source }) => /POSTGRES_URL \? describe : describe\.skip/.test(source))
  .map(({ file, source }) => ({
    file,
    suites: [...source.matchAll(/^RUN\(\s*"([^"]+)"/gm)].map((match) => match[1]),
  }));

describe("Postgres-only suites are selected by the Postgres job", () => {
  test("the filter was read from the workflow", () => {
    expect(filter).toBe("postgres");
  });

  test("the gated files were found", () => {
    expect(gated.length).toBeGreaterThan(0);
    for (const { file, suites } of gated) {
      expect(suites.length, `${file} gates on POSTGRES_URL but declares no RUN suite`).toBeGreaterThan(0);
    }
  });

  /**
   * Case-sensitively, because that is how `-t` compares. "on Postgres" reads as
   * though it is covered and is not, which is the whole failure.
   */
  test.each(gated.flatMap(({ file, suites }) => suites.map((name) => [file, name] as const)))(
    "%s: %s",
    (file, name) => {
      expect(
        name.includes(filter),
        `${file} runs only with a Postgres URL, but "${name}" does not contain ` +
          `"${filter}" — the Postgres job's -t filter is case-sensitive, so this ` +
          `suite is selected by neither job`,
      ).toBe(true);
    },
  );
});
