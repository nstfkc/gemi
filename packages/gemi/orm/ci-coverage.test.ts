import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * CI runs the whole package, and this is what keeps it that way.
 *
 * Two narrowings have happened here, in opposite directions, and this file has
 * guarded each in turn.
 *
 * The unit step was once `vitest run orm database` — an *inclusive* path filter.
 * The stated reason for not running everything was that `app/`'s router tests
 * fail and are unrelated (#163). That reason covered six files; the filter
 * excluded fourteen. `container`, `foundation`, `http`, `support`, `app/App` and
 * three of the router tests all passed and were never run.
 *
 * The direction mattered more than the count. An inclusive filter fails silently
 * one way — a test file added outside those two words is skipped and nothing
 * reports it, which is how #201's fifteen type assertions went unnoticed. A
 * named exclusion list is the opposite: anything added is covered by default,
 * and narrowing coverage means deleting a line rather than not writing one.
 *
 * So the filter became six `--exclude` flags, and this file checked that each
 * named a file that still existed — an exclusion outliving its file excludes
 * nothing while reading as though it does.
 *
 * **Both are now gone.** #163 turned out to be three problems under one label:
 * three superseded copies in `app/` that nothing imported, a stale assertion
 * about the live router, and a test written against `bun:test` that this runner
 * could not collect. Deleted, corrected and ported respectively — so there is
 * nothing left to exclude, and the honest command is the bare one.
 *
 * What this file guards now is that it stays bare. An exclusion is a failure
 * nobody looks at again; the six lasted long enough to be described as
 * permanent, and one of them was hiding a real bug in shipped router code.
 */
const ROOT = join(import.meta.dirname, "../../..");
const PACKAGE = join(import.meta.dirname, "..");

const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/**
 * The workflow with its comments stripped.
 *
 * Checked against this rather than the raw file because the comment explaining
 * the change quotes the commands it replaced — an earlier version of the test
 * below read the whole file and failed on its own prose. A guard that cannot
 * tell a command from a sentence about a command would be satisfied by deleting
 * the explanation.
 */
const commands = workflow
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/** The `--exclude '**‍/path'` arguments of the unit-test step. */
const excluded = [...commands.matchAll(/--exclude '\*\*\/([^']+)'/g)].map(
  (match) => match[1],
);

describe("CI's unit step covers the package", () => {
  test("it does not use an inclusive path filter", () => {
    expect(
      commands,
      "the unit step is back to a path filter, which skips new files silently",
    ).not.toContain("vitest run orm database");
  });

  test("it excludes nothing", () => {
    expect(
      excluded,
      `CI excludes ${excluded.length} file(s) again. If they are red, fix or ` +
        `delete them — an exclusion is a failure nobody looks at again, which ` +
        `is what #163 was.`,
    ).toEqual([]);
  });

  /**
   * Kept for the case where an exclusion is reintroduced despite the above: a
   * pattern that matches nothing excludes nothing and reads as though it still
   * does, so whatever is named has to be real. Vacuous while the list is empty,
   * which is the intended state.
   */
  test("any exclusion that does exist names a real file", () => {
    for (const path of excluded) {
      expect(
        existsSync(join(PACKAGE, path)),
        `CI excludes ${path}, which is not there — the exclusion is stale`,
      ).toBe(true);
    }
  });
});
