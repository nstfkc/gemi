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

/**
 * Files that gate a suite behind a Postgres URL, and the suite names they use.
 *
 * The pattern admits any `POSTGRES…_URL`, not just `POSTGRES_URL` itself. There
 * is a second one now — `POSTGRES_LISTS_URL`, for the scalar-list schema that
 * needs its own database (#300) — and a check written against the one name
 * would have silently stopped covering the file that introduced it. That is the
 * precise shape of the failure this test exists for: three suites were selected
 * by neither job, and nothing said so.
 */
const gated = readdirSync(MODELS)
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => ({ file, source: readFileSync(join(MODELS, file), "utf8") }))
  .filter(({ source }) =>
    /POSTGRES(?:_[A-Z]+)*_URL \? describe : describe\.skip/.test(source),
  )
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

/**
 * The header does not tell its reader Postgres is absent while the job is there.
 *
 * `ci.yml` opened with "Postgres is deliberately not here yet … adding a
 * service container is a sensible next step and a separate decision". The step
 * was taken in #173. The paragraph describing it as not-taken stayed, 160 lines
 * above the `postgres:` job that contradicts it (#261).
 *
 * A different failure from the drift #246 fixed — that was numbers moving after
 * they were measured. This was a claim about the *shape* of the workflow that
 * was simply false, and false in the expensive direction: a reader who believes
 * the header concludes the repository has no Postgres coverage at all, and
 * stops before reaching the sentence that would correct them.
 *
 * Checked as a contradiction inside the file rather than by asserting today's
 * wording, so rephrasing the header is free and un-taking the claim is not.
 */
describe("the workflow header agrees with the workflow", () => {
  const header = workflow.slice(0, workflow.indexOf("\non:"));

  test("the Postgres job is what the header is checked against", () => {
    // The premise. Without this the two tests below pass on a file that has no
    // Postgres job at all, which is the one state where the old header was true.
    expect(workflow).toMatch(/^\s{2}postgres:$/m);
    expect(workflow).toContain("postgres:16");
  });

  test("it does not say Postgres is absent", () => {
    expect(
      header,
      "the header still describes Postgres as not-yet-in-CI, and the postgres: job is below it",
    ).not.toMatch(/deliberately not here/i);
    expect(header).not.toMatch(/adding a service container is a sensible next step/i);
  });

  test("it says why there are two jobs", () => {
    // The reason is the part a reader needs and the part that cannot be guessed:
    // one generated client per provider is what makes this two checkouts rather
    // than two steps.
    expect(header).toMatch(/two jobs/i);
    expect(header).toMatch(/@prisma\/client/);
  });

  /**
   * The half of the old paragraph that was true, and is worth keeping: it
   * describes a developer's machine, where there is no service container.
   */
  test("it keeps what a local run covers", () => {
    expect(header).toContain("TEST_POSTGRES_URL");
    expect(header).toMatch(/SQLite only/i);
  });
});
