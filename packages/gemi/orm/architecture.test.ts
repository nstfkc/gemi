import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Two of the ORM's stated invariants, asserted as properties of the directory
 * rather than of any one file — the same shape as `runtime-isolation.test.ts`,
 * and for the same reason: a single line added while implementing an operation
 * is how either of them would go, and no unit test would notice.
 *
 *   **1. One choke point** — `Model.$exec` is the only thing that touches the
 *       database.
 *   **2. Compile is pure** — and in particular, "lets the entire compiler be
 *       unit-tested with no database at all". `relation-filters.ts` states the
 *       operative half: `compile/` may not import `policy.ts`.
 *   **3. `shape` is a static on the model class** — subclassing is the
 *       extension mechanism, so shaping has to route through it.
 *   **4. The dialect seam** — the compiler asks the dialect, it does not test
 *       it.
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
   * **Invariant 2, structurally: the compiler cannot reach the database.**
   *
   * The value half is `binding.invariants.test.ts`. This is the other one, and
   * it is what the invariant means by "lets the entire compiler be unit-tested
   * with no database at all" — every `compile/**` test in this repo constructs
   * a schema and a dialect and nothing else, which only stays true while the
   * import graph allows it.
   *
   * Computed **transitively**, because a one-hop check is the version that
   * passes while being wrong: `compile/x.ts` importing a helper that imports
   * `Model.ts` reads as clean and drags the whole runtime in behind it.
   *
   * `policy.ts` is called out by name in `relation-filters.ts` for a specific
   * reason — policies rewrite the *arg tree* before the compiler sees it, which
   * is what makes a scope a two-line `AND` rather than SQL surgery. A compiler
   * that could consult a policy would invite the surgery back.
   */
  const FORBIDDEN_TO_COMPILER = [
    "Model.ts",
    "context.ts",
    "policy.ts",
    "provenance.ts",
    "sql.ts",
    "soft-deletes.ts",
    "active-record.ts",
    "database/DatabaseManager",
  ];

  test("nothing the compiler imports can reach the database", () => {
    const resolve = (from: string, spec: string) => {
      if (!spec.startsWith(".")) return null;
      const base = normalize(join(dirname(from), spec));
      for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    };

    const seeds = FILES.filter(([name]) => name.startsWith("compile/")).map(
      ([, path]) => path,
    );
    expect(seeds.length).toBeGreaterThan(10);

    const seen = new Set(seeds);
    const stack = [...seeds];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const source = read(current);
      for (const match of source.matchAll(
        /^\s*import\s+(?:type\s+)?[^;]*?from\s+"([^"]+)"/gm,
      )) {
        const resolved = resolve(current, match[1]);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          stack.push(resolved);
        }
      }
    }

    const reached = [...seen]
      .map((path) => relative(ROOT, path))
      .filter((name) => FORBIDDEN_TO_COMPILER.some((bad) => name.includes(bad)))
      .sort();

    expect(reached, `the compiler reaches ${reached.join(", ")}`).toEqual([]);
  });

  /**
   * **Invariant 3: shaping goes through the static, or subclassing stops
   * working.**
   *
   * `$shape` is a static on the model base precisely so that
   * `ActiveRecordModel` can override it and every model extending it gets rows
   * as instances "with zero changes to the twelve operations". That only holds
   * while `$exec` is the thing calling it.
   *
   * The failure is quiet and partial: one operation calling `plan.shape(rows)`
   * directly still returns correct data, so nothing fails — except that this
   * one operation hands back plain objects on a model whose every other
   * operation returns instances.
   */
  test("only a $shape implementation calls the plan's shaper", () => {
    const callers = FILES.filter(([, path]) => /plan\.shape\(/.test(read(path)))
      .map(([name]) => name)
      .sort();

    // The base's own implementation, and the one override that exists to prove
    // the static was worth holding.
    expect(callers).toEqual(["Model.ts", "active-record.ts"]);
  });

  test("...and $exec reaches it through the static rather than directly", () => {
    const model = read(join(ROOT, "Model.ts"));

    expect(model).toMatch(/this\.\$shape\(plan,/);
    // Exactly one shaping call in the whole execution path — a second would be
    // an operation that had grown its own.
    expect(model.match(/this\.\$shape\(/g) ?? []).toHaveLength(1);
  });

  /**
   * **Nothing is exported that only its own file uses.**
   *
   * `orm/index.ts` is the public surface and is curated — the `PRE_SCOPED`
   * symbol is deliberately absent from it so an application cannot forge one.
   * A module-level `export` is a smaller version of the same decision: it is
   * how a helper becomes something another file may reach for, and exporting
   * one that nothing imports widens the surface for nothing.
   *
   * Three had drifted that way — `relation-filters.ts`'s two operator tuples,
   * used only by the function directly beneath them, and `corpus.ts`'s
   * `LITERAL`, which I exported when extracting that corpus and never needed
   * to. None was reachable from `index.ts`, so none was public; they were just
   * wider than they had to be.
   *
   * Test files count as references, because an export existing *for* a test is
   * a real reason — `isTracked` says so in as many words.
   */
  const MAY_BE_EXPORTED_UNUSED: string[] = [
    // Nothing today. An entry here is a deliberate exception with a reason
    // beside it, not a place to put whatever this test happens to flag.
  ];

  test("no export is referenced only inside its own file", () => {
    const declared = new Map<string, string>();
    const sources = new Map<string, string>();

    for (const [name, path] of FILES) {
      const content = read(path);
      sources.set(name, content);
      if (name === "index.ts") continue;

      for (const match of content.matchAll(
        /^export (?:async )?function (\w+)|^export const (\w+)|^export class (\w+)/gm,
      )) {
        const exported = match[1] ?? match[2] ?? match[3];
        // A name declared in two files is ambiguous to a text scan; skip rather
        // than guess, since a false positive here reads as a real finding.
        declared.set(exported, declared.has(exported) ? "" : name);
      }
    }

    // Tests are references: an export that exists for a test is justified.
    for (const path of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
      if (!path.name.endsWith(".test.ts")) continue;
      const full = join((path as { parentPath?: string }).parentPath ?? ROOT, path.name);
      sources.set(`test:${full}`, read(full));
    }

    const unreferenced: string[] = [];
    for (const [name, home] of declared) {
      if (home === "" || MAY_BE_EXPORTED_UNUSED.includes(name)) continue;

      const used = [...sources.entries()].some(
        ([file, content]) =>
          file !== home && new RegExp(`\\b${name}\\b`).test(content),
      );
      if (!used) unreferenced.push(`${home} exports ${name}, and nothing else uses it`);
    }

    expect(unreferenced, unreferenced.join("\n")).toEqual([]);
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
