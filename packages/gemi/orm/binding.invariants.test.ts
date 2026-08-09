import { beforeEach, describe, expect, test, vi } from "vitest";

import { compileAggregate } from "./compile/aggregate";
import { createBindContext } from "./compile/fragment";
import { compileGroupBy } from "./compile/group-by";
import { compileRead } from "./compile/read";
import { compileWrite } from "./compile/write";
import { AGGREGATES, GROUPS, READS, vary, WRITES } from "./corpus";
import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import {
  account,
  membership,
  organization,
  post,
  profile,
  tag,
  userWithProfile,
} from "./fixtures";
import * as registry from "./registry";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();
const DIALECTS = [
  ["sqlite", sqlite],
  ["postgres", postgres],
] as const;

/**
 * **Invariant 2: every value is bound; none reaches the SQL text.**
 *
 * This is the whole of the injection argument. `compile/fragment.ts`'s comment
 * puts it plainly — safety does not come from a tagged template, because an ORM
 * query's *shape* is dynamic. It comes from two rules: identifiers only ever
 * come from the generated schema, and every value is a bound parameter.
 *
 * There was a test for the second rule already, over seven write statements. It
 * strips double-quoted spans (identifiers) and asserts no digit survives — which
 * catches a spliced *number* and, by construction, cannot catch a spliced
 * *string*: SQL string literals are single-quoted, so they are not stripped, and
 * a value like `a@b.c` contains no digit either way.
 *
 * The property below is type-agnostic and needs no heuristic: compile the same
 * shape twice with different values and the text must be **byte-identical**.
 * Anything reaching the text shows up as a difference, whatever its type.
 */
describe("no value reaches the SQL text", () => {
  beforeEach(() => {
    registry.clearRegistry();
    for (const [name, schema] of [
      ["User", userWithProfile],
      ["Account", account],
      ["Organization", organization],
      ["Post", post],
      ["Tag", tag],
      ["Profile", profile],
      ["Membership", membership],
    ] as const) {
      registry.register(name, class { static $schema = schema });
    }
  });

  const compileAny = (
    op: string,
    args: unknown,
    dialect: SqliteDialect | PostgresDialect,
  ) => {
    if (op === "aggregate") {
      return compileAggregate(userWithProfile, op as never, args as never, dialect as never);
    }
    if (op === "groupBy") {
      return compileGroupBy(userWithProfile, op as never, args as never, dialect as never);
    }
    if (op === "findMany" || op === "findFirst") {
      return compileRead(userWithProfile, op as never, args as never, dialect as never);
    }
    return compileWrite(userWithProfile, op as never, args as never, dialect as never);
  };

  /** The corpus as `[operation, args]`, refusals dropped by the caller's check. */
  const entries: [string, unknown][] = [
    ...READS.map((args) => ["findMany", args] as [string, unknown]),
    ...WRITES,
    ...AGGREGATES.map((args) => ["aggregate", args] as [string, unknown]),
    ...GROUPS.map((args) => ["groupBy", args] as [string, unknown]),
  ];

  /**
   * The corpus-wide property. `vary` replaces every scalar that is bound as a
   * parameter and leaves structure alone, so a difference in the text is a
   * value that escaped binding.
   */
  test.each(DIALECTS)("the same shape with different values compiles alike — %s", (_name, dialect) => {
    const differing: string[] = [];
    let checked = 0;

    for (const [op, args] of entries) {
      const twin = vary(args);
      if (JSON.stringify(twin) === JSON.stringify(args)) continue;

      let before: string;
      let after: string;
      try {
        before = compileAny(op, args, dialect).text;
        after = compileAny(op, twin, dialect).text;
      } catch {
        continue; // Refusals are `plan-key.invariants.test.ts`'s subject.
      }

      checked++;
      if (before !== after) {
        differing.push(`${op} ${JSON.stringify(args)}\n  ${before}\n  ${after}`);
      }
    }

    expect(differing, differing.join("\n\n")).toEqual([]);
    // The corpus is doing work — a `vary` that changed nothing would pass.
    expect(checked).toBeGreaterThan(40);
  });

  /**
   * **...and a plan compiled from one call's values binds the *next* call's.**
   *
   * The property above compiles each shape twice and compares the two texts,
   * which is blind to a whole class: a compiler that reads a value at compile
   * time and closes over it emits byte-identical text for both, keys
   * identically, and is still wrong the moment the plan is reused. And it is
   * reused — that is what `getOrCompile` is for, so this is the live path
   * rather than a hypothetical one.
   *
   * Found while covering JSON path filters (#301), because a path is where the
   * mistake is easiest to make: it is the one argument whose value decides part
   * of an expression's *meaning*, so building the fragment from it reads as
   * natural. Written over the whole corpus rather than over `path` alone,
   * since nothing about the failure is specific to it — `where: { name: "a" }`
   * compiled with a captured `"a"` fails the same way and was equally
   * unasserted.
   *
   * `bind` rather than `text` is the whole point: compile from `args`, bind
   * `twin`, and require the same array the plan compiled *for* `twin` produces.
   */
  test.each(DIALECTS)("a plan compiled for one call binds the next call's values — %s", (_name, dialect) => {
    /**
     * Two bound values are *supposed* to differ between two calls of one plan:
     * `@default(now())` / `@updatedAt`, and `@default(cuid())`. Both are
     * generated at bind time, which is the whole reason they are generated
     * there rather than compiled in, so neither can be compared as-is.
     *
     * The clock is **frozen** rather than masked, because masking it cannot be
     * done in a dialect-agnostic way: `encode` turns a `Date` into a number on
     * SQLite and passes it through on Postgres, so a `value instanceof Date`
     * mask covers one dialect and silently drops the other — and then flakes
     * on whichever millisecond boundary falls between two binds. Freezing
     * removes the difference instead of hiding it, and leaves a genuinely stale
     * timestamp visible.
     *
     * `cuid` has no clock to freeze — it is random by construction — so it is
     * masked, by kind rather than by position so it stays right if the column
     * order moves.
     */
    const CUID = /^c[a-z0-9]{20,}$/;
    const masked = (bound: unknown[]) =>
      bound.map((value) =>
        typeof value === "string" && CUID.test(value) ? "<generated cuid>" : value,
      );

    const stale: string[] = [];
    let checked = 0;

    vi.useFakeTimers();
    try {
      for (const [op, args] of entries) {
        const twin = vary(args);
        if (JSON.stringify(twin) === JSON.stringify(args)) continue;

        let reused: unknown[];
        let fresh: unknown[];
        try {
          // The cache hit, spelled out: a plan compiled for `args`, handed
          // `twin`. `getOrCompile` does exactly this whenever two calls share a
          // key, which every pair here does by construction.
          reused = masked(compileAny(op, args, dialect).bind(twin, createBindContext()));
          fresh = masked(compileAny(op, twin, dialect).bind(twin, createBindContext()));
        } catch {
          continue; // Refusals are `plan-key.invariants.test.ts`'s subject.
        }

        checked++;
        if (JSON.stringify(reused) !== JSON.stringify(fresh)) {
          stale.push(
            `${op} ${JSON.stringify(args)}\n  reused ${JSON.stringify(reused)}\n  fresh  ${JSON.stringify(fresh)}`,
          );
        }
      }
    } finally {
      vi.useRealTimers();
    }

    expect(stale, stale.join("\n\n")).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });

  /**
   * A JSON path, in each dialect's own grammar — appended to the cases below
   * because it is the value hardest to keep bound.
   *
   * The path is the one argument whose *value* decides what an expression
   * means, and `compile/where.ts` says so at the branch. That makes "read it at
   * compile time and build the fragment from it" the natural mistake, and it is
   * invisible to the two properties above: such a compiler emits byte-identical
   * text for two different paths and keys them identically. What it does not do
   * is put the path in the binding, which is what this asks.
   *
   * Dialect-keyed rather than shared, because the grammars are not
   * interchangeable: Postgres refuses `"$.a"` and SQLite refuses `["a"]`.
   */
  const JSON_BINDING_CASES: Record<string, [string, unknown, unknown[]][]> = {
    sqlite: [
      [
        "findMany",
        { where: { metadata: { path: "$.needlePath", equals: "needleValue" } } },
        ["$.needlePath", "needleValue"],
      ],
    ],
    postgres: [
      [
        "findMany",
        { where: { metadata: { path: ["needlePath"], equals: "needleValue" } } },
        ["needlePath", "needleValue"],
      ],
    ],
  };

  /**
   * ...and the values are **actually bound**, not dropped.
   *
   * Without this the property above is satisfiable by a compiler that throws
   * every value away: two shapes would compile alike because neither carries
   * anything. Same vacuity trap that made `plan-key.invariants.test.ts` pass
   * against a reintroduced #92 on its first run.
   */
  test.each(DIALECTS)("...and every value is present in the binding — %s", (name, dialect) => {
    const cases: [string, unknown, unknown[]][] = [
      ["findMany", { where: { name: "needle" } }, ["needle"]],
      ["findMany", { where: { name: { contains: "needle" } } }, ["%needle%"]],
      ["findMany", { where: { id: { in: [11, 22, 33] } } }, [11, 22, 33]],
      ["update", { where: { id: 7 }, data: { name: "needle" } }, ["needle", 7]],
      ["deleteMany", { where: { name: "needle" } }, ["needle"]],
      ...JSON_BINDING_CASES[name],
    ];

    for (const [op, args, expected] of cases) {
      const plan = compileAny(op, args, dialect);
      const bound = plan.bind(args, createBindContext());

      // Serialised rather than `toContain`, because the two dialects bind an
      // `in` list differently and both are right: SQLite emits one placeholder
      // per member, Postgres binds the whole list as a single array parameter
      // (`{"11","22","33"}`). What has to hold either way is that every value
      // is *in* the binding rather than in the text.
      const serialised = JSON.stringify(bound);
      for (const value of expected) {
        expect(
          serialised.includes(JSON.stringify(value)) || serialised.includes(String(value)),
          `${op} ${JSON.stringify(args)} did not bind ${String(value)} — bound ${serialised}`,
        ).toBe(true);
      }
    }
  });

  /**
   * The adversarial half, kept alongside the property because it is the one a
   * reader reaches for — and because it covers the string case the digit
   * heuristic could not.
   *
   * Each value is chosen to be unmistakable in a statement: quote-breaking,
   * identifier-breaking, LIKE metacharacters, a backslash, and a non-ASCII
   * character.
   */
  const HOSTILE: [string, string, string][] = [
    ["a quote and a comment", `'; drop table "User"; --`, "drop table"],
    ["an identifier break", `x" or "1"="1`, `1"="1`],
    ["LIKE metacharacters", `%_wildcards%`, `%_wildcards%`],
    ["a backslash", `back\\slash`, `back\\slash`],
    ["a non-ASCII character", `snowman ☃ trailing`, `☃`],
  ];

  test.each(DIALECTS)("a hostile value never appears in the statement — %s", (_name, dialect) => {
    const found: string[] = [];

    for (const [label, value, needle] of HOSTILE) {
      const shapes: [string, unknown][] = [
        ["findMany", { where: { name: value } }],
        ["findMany", { where: { name: { contains: value } } }],
        ["findMany", { where: { name: { startsWith: value } } }],
        ["findMany", { where: { name: { in: [value, "b"] } } }],
        ["findMany", { where: { OR: [{ name: value }, { email: value }] } }],
        ["findMany", { where: { accounts: { some: { provider: value } } } }],
        ["create", { data: { email: value, name: value } }],
        ["createMany", { data: [{ email: value }, { email: "b" }] }],
        ["update", { where: { id: 1 }, data: { name: value } }],
        ["updateMany", { where: { name: value }, data: { name: value } }],
        [
          "upsert",
          { where: { email: value }, create: { email: value }, update: { name: value } },
        ],
      ];

      for (const [op, args] of shapes) {
        let text: string;
        try {
          text = compileAny(op, args, dialect).text;
        } catch {
          continue;
        }
        if (text.includes(needle)) found.push(`${label} in ${op}: ${text.slice(0, 140)}`);
      }
    }

    expect(found, found.join("\n")).toEqual([]);
  });

  /**
   * ...and the hostile value survives *binding* intact, which is the other half
   * of "bound rather than escaped". An ORM that sanitised the value instead of
   * parameterising it would pass the test above and corrupt the data.
   */
  test.each(DIALECTS)("a hostile value is bound unchanged — %s", (_name, dialect) => {
    for (const [, value] of HOSTILE) {
      const args = { where: { id: 1 }, data: { name: value } };
      const plan = compileAny("update", args, dialect);
      expect(plan.bind(args, createBindContext())).toContain(value);
    }
  });
});
