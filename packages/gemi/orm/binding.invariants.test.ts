import { beforeEach, describe, expect, test } from "vitest";

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
   * ...and the values are **actually bound**, not dropped.
   *
   * Without this the property above is satisfiable by a compiler that throws
   * every value away: two shapes would compile alike because neither carries
   * anything. Same vacuity trap that made `plan-key.invariants.test.ts` pass
   * against a reintroduced #92 on its first run.
   */
  test.each(DIALECTS)("...and every value is present in the binding — %s", (_name, dialect) => {
    const cases: [string, unknown, unknown[]][] = [
      ["findMany", { where: { name: "needle" } }, ["needle"]],
      ["findMany", { where: { name: { contains: "needle" } } }, ["%needle%"]],
      ["findMany", { where: { id: { in: [11, 22, 33] } } }, [11, 22, 33]],
      ["update", { where: { id: 7 }, data: { name: "needle" } }, ["needle", 7]],
      ["deleteMany", { where: { name: "needle" } }, ["needle"]],
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
