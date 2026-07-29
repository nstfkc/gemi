import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Two of the ORM's stated invariants, asserted as properties of the directory
 * rather than of any one file — the same shape as `runtime-isolation.test.ts`,
 * and for the same reason: a single line added while implementing an operation
 * is how either of them would go, and no unit test would notice.
 *
 *   **1. `Model.$exec` is the single door to the database.**
 *   **4. The dialect seam — the compiler asks the dialect, it does not test it.**
 *
 * Both are enforced here by allow-list rather than by prohibition, because both
 * have real exceptions. A list makes an exception a decision someone wrote
 * down; a bare `grep` for the pattern would either fail today or be useless.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      // Tests are not runtime code, and this one has to name both patterns in
      // order to assert against them.
      out.push(path);
    }
  }
  return out;
}

const ROOT = import.meta.dirname;
const FILES = sourceFiles(ROOT).map((path) => [relative(ROOT, path), path] as const);
const read = (path: string) => readFileSync(path, "utf8");

describe("the ORM's seams", () => {
  test("the scan covers the whole directory", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  /**
   * **One door to the driver.**
   *
   * `conn.unsafe` is where a statement stops being data and starts being a
   * query. Everything the ORM does around a query — the plan cache, the policy
   * layer, the ambient transaction, the error translation, the slow-transaction
   * timer — hangs off `$exec` calling it. A second caller elsewhere would get
   * none of that, and would look completely ordinary in review.
   *
   * The implicit many-to-many join table is the one statement with no model
   * behind it, so it cannot be compiled through a model's plan. It does *not*
   * get its own door: `$exec` hands the nested-write steps an executor closed
   * over the connection it already resolved, so the pair statements join the
   * caller's transaction like everything else. `nested-writes.ts` builds that
   * SQL and never runs it.
   */
  const DRIVER_DOOR = ["Model.ts"];

  test("only Model.ts reaches the driver", () => {
    const callers = FILES.filter(([, path]) => /\.unsafe\(/.test(read(path))).map(
      ([name]) => name,
    );

    expect(callers.sort()).toEqual(DRIVER_DOOR);
  });

  test("...and the join-table statements go through the executor, not the pool", () => {
    const nested = read(join(ROOT, "compile/nested-writes.ts"));

    // It builds pair SQL...
    expect(nested).toMatch(/delete from \$\{quoted\(join\.table\)\}|insert into \$\{quoted\(join\.table\)\}/);
    // ...and hands it to the executor rather than running it.
    expect(nested).toMatch(/executor\.query\(/);
    expect(nested).not.toMatch(/\.unsafe\(/);
  });

  /**
   * **The dialect seam.**
   *
   * `plan.ts` puts the rule in the middle of `planKey`: asking the dialect is
   * what keeps `if (dialect === "postgres")` out of the compiler. A dialect
   * that has to be *recognised* rather than *asked* is one whose differences
   * are scattered across the compiler instead of declared in one file, and the
   * third dialect is what pays for it.
   *
   * Two files legitimately compare the name, and both choose a **strategy**
   * rather than emit SQL:
   *
   *   - `strategy.ts` — lateral on Postgres, batched elsewhere. Iteration 9
   *     deliverable 6 owns that rule and this is where it lives.
   *   - `lateral.ts` — the lateral strategy declining a node on a dialect that
   *     cannot express it, which is the mechanism that makes the rule above
   *     safe rather than a gamble.
   *
   * Everywhere else `dialect.name` may still *appear* — in a refusal's message,
   * or in the plan key, which must differ per dialect. What it may not do is
   * decide what SQL comes out.
   */
  const MAY_COMPARE_DIALECT = ["compile/lateral.ts", "compile/strategy.ts"];

  test("only the strategy chooser tests the dialect's name", () => {
    // A comparison, not a mention: `=== "postgres"`, `!== dialect.name`, a
    // switch on it, or an `instanceof` on a concrete dialect class.
    const comparison =
      /dialect\.name\s*[=!]==|[=!]==\s*dialect\.name|switch\s*\(\s*dialect\.name|instanceof\s+(Postgres|Sqlite)Dialect/;

    const testers = FILES.filter(([name, path]) => {
      // `dialect/` is where the differences are declared, so a dialect naming
      // itself there is the seam working rather than leaking.
      if (name.startsWith("dialect/")) return false;
      return comparison.test(read(path));
    }).map(([name]) => name);

    expect(testers.sort()).toEqual(MAY_COMPARE_DIALECT);
  });

  /**
   * ...and the allow-list cannot go stale: each entry has to still contain the
   * thing it excuses. An exception that stops being needed should be removed,
   * not left standing as permission.
   */
  test.each([...DRIVER_DOOR, ...MAY_COMPARE_DIALECT])("%s still needs its exemption", (name) => {
    const content = read(join(ROOT, name));
    const pattern = DRIVER_DOOR.includes(name)
      ? /\.unsafe\(/
      : /dialect\.name\s*[=!]==/;

    expect(pattern.test(content), `${name} is exempted but no longer matches`).toBe(true);
  });
});
