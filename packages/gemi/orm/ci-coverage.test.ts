import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * CI runs the whole package except a named red set, and the names are real.
 *
 * The unit-test step used to be `vitest run orm database` — an *inclusive* path
 * filter. The stated reason for not running everything was that `app/`'s router
 * tests fail on `feat/orm` and are unrelated to this work (#163).
 *
 * That reason covers six files. The filter excluded fourteen: `container`,
 * `foundation`, `http`, `support`, `app/App` and three of the router tests all
 * pass and were never run. 55 of the package's 61 test files are green; CI was
 * running 47.
 *
 * The direction matters more than the count. An inclusive filter fails silently
 * one way — a test file added outside those two words is skipped, and nothing
 * reports it. That is exactly how #201's fifteen type assertions went unnoticed.
 * A named exclusion list is the opposite: anything added is covered by default,
 * and narrowing coverage means deleting a line rather than merely not writing
 * one.
 *
 * What that leaves is a new way to be wrong — an exclusion that outlives the
 * file it names. Rename or fix one of the six and the pattern matches nothing,
 * which is invisible in a passing run. So each is checked to still exist.
 */
const ROOT = join(import.meta.dirname, "../../..");
const PACKAGE = join(import.meta.dirname, "..");

const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/**
 * The workflow with its comments stripped.
 *
 * Checked against this rather than the raw file because the comment explaining
 * the change quotes the command it replaced — the first version of the test
 * below read the whole file and failed on its own prose. A guard that cannot
 * tell a command from a sentence about a command would be satisfied by deleting
 * the explanation.
 */
const commands = workflow
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/** The `--exclude '**‍/path'` arguments of the unit-test step. */
const excluded = [...workflow.matchAll(/--exclude '\*\*\/([^']+)'/g)].map(
  (match) => match[1],
);

describe("CI's unit step covers the package", () => {
  test("it no longer uses an inclusive path filter", () => {
    expect(
      commands,
      "the unit step is back to a path filter, which skips new files silently",
    ).not.toContain("vitest run orm database");
  });

  test("it excludes a named set", () => {
    expect(excluded.length).toBeGreaterThan(0);
  });

  /**
   * A pattern that matches nothing excludes nothing, and reads as though it
   * still does. That is the failure this list introduces, so it is the one
   * checked.
   */
  test.each(excluded)("%s still exists", (path) => {
    expect(
      existsSync(join(PACKAGE, path)),
      `CI excludes ${path}, which is not there — the exclusion is stale`,
    ).toBe(true);
  });

  /**
   * The exclusions are #163's failures. If one is fixed it should be run, not
   * left excluded — so the list is pinned to the reason, and the reason has to
   * be findable.
   */
  test("the reason is recorded next to them", () => {
    expect(workflow).toContain("#163");
  });
});
