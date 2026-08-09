import { beforeEach, describe, expect, test } from "vitest";

import { compileAggregate } from "./compile/aggregate";
import { compileGroupBy } from "./compile/group-by";
import { compileRead } from "./compile/read";
import { compileWrite } from "./compile/write";
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
import { AGGREGATES, GROUPS, READS, vary, WRITES } from "./corpus";
import { clearPlanCache, getOrCompile, planCacheStats, planKey } from "./plan";
import * as registry from "./registry";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();
const DIALECTS = [
  ["sqlite", sqlite],
  ["postgres", postgres],
] as const;

/**
 * The plan cache's two invariants, asserted over a corpus rather than case by
 * case.
 *
 * Both have been broken before, in opposite directions:
 *
 *   - **#92** — a `having` threshold reached the key, so 200 thresholds made
 *     200 entries. A value leaking into the key is unbounded growth.
 *   - **#100** — `$compositeIn` was reachable by callers, which is the other
 *     direction: two different queries sharing a key means one runs the
 *     other's statement.
 *
 * Each was fixed with a test for that case. Neither left anything asserting the
 * *property*, so the next instance would arrive the same way. These do:
 *
 *   1. same key ⇒ same SQL — no two shapes share an entry unless they compile
 *      identically;
 *   2. a bound value never reaches the key — varying every parameter leaves it
 *      unchanged;
 *   3. ...but a *literal* position does, because it decides the statement.
 *
 * The corpus is the thing to extend when a new argument is implemented. It is
 * deliberately broad rather than minimal: the cost of a case is one line, and
 * the failure mode being guarded is silent.
 */
describe("the plan key", () => {
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

  /**
   * Every corpus entry, compiled — and the ones that did not.
   *
   * The refusals are returned rather than swallowed, because swallowing them
   * is how this test was vacuous on its first run: two `having` entries named
   * a column that was not in `by`, so they never compiled, were silently
   * dropped, and the #92 case they existed to cover tested nothing. A dropped
   * entry has to be visible or the corpus can rot without a failure.
   */
  const compiled = (dialect: SqliteDialect | PostgresDialect) => {
    const out: [string, unknown, string][] = [];
    const refused: string[] = [];
    const attempt = (op: string, args: unknown, run: () => { text: string }) => {
      try {
        out.push([op, args, run().text]);
      } catch (error) {
        refused.push(`${op} ${JSON.stringify(args)} — ${(error as Error).message}`);
      }
    };

    for (const args of READS) {
      for (const op of ["findMany", "findFirst"]) {
        attempt(op, args, () => compileRead(userWithProfile, op as never, args as never, dialect as never));
      }
    }
    for (const [op, args] of WRITES) {
      attempt(op, args, () => compileWrite(userWithProfile, op as never, args as never, dialect as never));
    }
    for (const args of AGGREGATES) {
      attempt("aggregate", args, () =>
        compileAggregate(userWithProfile, "aggregate" as never, args as never, dialect as never),
      );
    }
    for (const args of GROUPS) {
      attempt("groupBy", args, () =>
        compileGroupBy(userWithProfile, "groupBy" as never, args as never, dialect as never),
      );
    }
    return { out, refused };
  };

  /**
   * The corpus compiles, apart from entries refused for a **named** reason.
   *
   * Not a formality — see `compiled`'s note. Listing the exceptions rather than
   * dropping them is what turns "this entry is not exercised" from invisible
   * into a decision: both below are real dialect and strategy limits, and if
   * either lifted, this test would say so rather than quietly gaining coverage.
   */
  const EXPECTED_REFUSALS: Record<string, RegExp[]> = {
    // Postgres has ILIKE; SQLite has no case-insensitive LIKE for non-ASCII,
    // and Prisma refuses `mode` there too.
    sqlite: [
      /mode: "insensitive"/,
      // The **array** path grammar, which is Postgres's. Prisma refuses it here
      // too — the split is the client's, not this ORM's — so every array-form
      // corpus entry is refused on this dialect and every JSONPath-string one
      // is refused on the other. Both lists exist so that a dialect quietly
      // accepting the form it should not fails here rather than silently
      // gaining coverage.
      /a JSON path is a JSONPath string/,
      // ...and the filters `jsonFilters` withholds on SQLite — `gt` and
      // `array_contains` in the corpus. Prisma answers "Unknown argument" for
      // both, so this refusal is parity rather than a gap.
      /is not available on sqlite/,
    ],
    postgres: [
      // The JSONPath-**string** grammar, which is SQLite's. The mirror of the
      // entry above.
      /a JSON path is an array of keys/,
    ],
  };

  /**
   * Refusals both dialects produce, kept apart from the per-dialect lists so
   * that "this is a dialect split" and "this is refused everywhere" do not read
   * alike.
   */
  const SHARED_REFUSALS = [
    // A per-parent `take` inside a to-many needs the lateral strategy, and
    // these compile with the default (batched) on both dialects — so it is
    // refused everywhere here, not only on SQLite.
    /accounts\.take/,
    // The four JSON path refusals that are about the *argument* rather than
    // about the database.
    //
    // Two of them need both grammars in the corpus and two do not, which is
    // worth stating precisely because the first draft here claimed the first
    // reason for all four. `assertPathShape` runs before the bare-path and
    // unknown-filter checks, so those two are reached by the array form on
    // Postgres and by the string form on SQLite — one spelling would leave one
    // dialect's copy unwalked. The other two are reached from either spelling on
    // either dialect: the `field.type !== "Json"` throw is above
    // `assertPathShape` entirely, and the empty check is above the grammar
    // branch inside it. Both spellings are in the corpus regardless; see the
    // note there for why.
    /is a String column/,
    /A JSON path cannot be empty/,
    /A 'path' needs a filter beside it/,
    /A JSON path filter takes/,
  ];

  test.each(DIALECTS)("every corpus entry compiles, or is refused by name — %s", (name, dialect) => {
    const { out, refused } = compiled(dialect);

    const expected = [...SHARED_REFUSALS, ...EXPECTED_REFUSALS[name]];
    const unexpected = refused.filter(
      (message) => !expected.some((pattern) => pattern.test(message)),
    );

    expect(unexpected, unexpected.join("\n")).toEqual([]);
    // ...and each named exception actually fired, so the list cannot go stale.
    for (const pattern of expected) {
      expect(refused.some((message) => pattern.test(message)), `${pattern} no longer refuses`).toBe(true);
    }
    expect(out.length).toBeGreaterThan(110);
  });

  /**
   * **Same key ⇒ same SQL.** The failure this guards is silent and severe: two
   * queries sharing an entry means the second runs the first's statement.
   */
  test.each(DIALECTS)("no two shapes share an entry unless they compile alike — %s", (_name, dialect) => {
    const byKey = new Map<string, { args: unknown; sql: string }[]>();

    for (const [op, args, sql] of compiled(dialect).out) {
      const key = planKey(dialect as never, "User", op as never, args);
      byKey.set(key, [...(byKey.get(key) ?? []), { args, sql }]);
    }

    const collisions = [...byKey.entries()]
      .filter(([, group]) => new Set(group.map((entry) => entry.sql)).size > 1)
      .map(([key, group]) => `${key}\n${group.map((e) => `  ${JSON.stringify(e.args)}\n    ${e.sql}`).join("\n")}`);

    expect(collisions, collisions.join("\n\n")).toEqual([]);
    // ...and the corpus is actually producing keys, so an empty run cannot pass.
    expect(byKey.size).toBeGreaterThan(100);
  });

  /**
   * **A bound value never reaches the key.** #92's direction: a leak is
   * unbounded cache growth, one entry per distinct value a caller happens to
   * pass.
   */
  test.each(DIALECTS)("varying every bound value leaves the key alone — %s", (_name, dialect) => {
    const leaks: string[] = [];
    let checked = 0;

    for (const [op, args] of compiled(dialect).out) {
      const twin = vary(args);
      if (JSON.stringify(twin) === JSON.stringify(args)) continue;

      checked++;
      const before = planKey(dialect as never, "User", op as never, args);
      const after = planKey(dialect as never, "User", op as never, twin);
      if (before !== after) {
        leaks.push(`${op} ${JSON.stringify(args)}\n  ${before}\n  ${after}`);
      }
    }

    expect(leaks, leaks.join("\n")).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });

  /**
   * **...but a literal position does reach it**, which is the other half and
   * the one `LITERAL_KEYS` documents at length: `omit: { password: true }` and
   * `{ password: false }` both shape to `boolean`, so sharing an entry would
   * hand the public endpoint the column the admin screen kept.
   *
   * Asserted in the direction that matters — these pairs must **differ**.
   */
  test.each(DIALECTS)("a switched-off projection is its own entry — %s", (_name, dialect) => {
    const pairs: [string, unknown, unknown][] = [
      ["omit", { omit: { password: true } }, { omit: { password: false } }],
      ["select", { select: { id: true, name: true } }, { select: { id: true, name: false } }],
      ["include", { include: { accounts: true } }, { include: { accounts: false } }],
      [
        "_count",
        { include: { _count: { select: { accounts: true } } } },
        { include: { _count: { select: { accounts: false } } } },
      ],
      ["orderBy", { orderBy: { id: "asc" } }, { orderBy: { id: "desc" } }],
      [
        "mode",
        { where: { name: { contains: "a" } } },
        { where: { name: { contains: "a", mode: "insensitive" } } },
      ],
    ];

    for (const [label, left, right] of pairs) {
      expect(
        planKey(dialect as never, "User", "findMany" as never, left),
        `${label} shares an entry with its opposite`,
      ).not.toBe(planKey(dialect as never, "User", "findMany" as never, right));
    }
  });

  /**
   * `take` and `skip` are the counterexample, and belong on the other side:
   * they compile to `limit ?` / `offset ?` with the number **bound**, so two
   * page sizes are one plan. Asserted because it is easy to assume a number
   * that changes the result set must change the statement, and here it does
   * not — a paginated endpoint would otherwise compile a plan per page.
   */
  test.each(DIALECTS)("pagination is bound, not compiled in — %s", (_name, dialect) => {
    const key = (args: unknown) =>
      planKey(dialect as never, "User", "findMany" as never, args);

    expect(key({ take: 1 })).toBe(key({ take: 5 }));
    expect(key({ skip: 1 })).toBe(key({ skip: 5 }));
    expect(key({ skip: 1, take: 2 })).toBe(key({ skip: 90, take: 20 }));

    // ...and present-versus-absent still differs, since that changes the text.
    expect(key({ take: 1 })).not.toBe(key({}));
    expect(key({ skip: 1, take: 2 })).not.toBe(key({ take: 2 }));
  });

  /**
   * A JSON path's **depth** is bound too, which is the case #301 opened to
   * measure rather than to reason about.
   *
   * Same shape as `take`/`skip` above and the opposite of the intuition: a
   * deeper path plainly selects something else, so it looks structural. It is
   * not. Postgres's `#>` takes the whole path as one `text[]` parameter, so
   * `["a"]` and `["a", "b", "c"]` compile to the same `("metadata" #>> $1)`,
   * and SQLite's path is a string, where depth was never in the shape at all.
   *
   * Left alone, `canonicalShape` records an array element-wise, so on Postgres
   * every distinct depth minted its own entry holding a statement identical to
   * its neighbours' — and a path built from a request (`?field=address.city`)
   * varies with the data the way an `in` list's length does. `path` is in
   * `LIST_KEYS` for that reason; this is what would notice it leaving.
   *
   * The SQL is asserted alongside the key deliberately. "One entry" is only
   * correct while it is also "one statement" — assert the key on its own and a
   * collapse that started serving the wrong text would still pass.
   */
  const JSON_PATHS: Record<string, unknown[]> = {
    sqlite: ["$.a", "$.a.b", "$.a.b.c"],
    // The last is an array *index*, spelled as a string — `#>` takes a `text[]`
    // and reaches the same element either way, and it is the spelling #380
    // leaves standing when it narrows `JsonPath` to `readonly string[]`.
    postgres: [["a"], ["a", "b"], ["a", "b", "c"], ["a", "0"]],
  };

  test.each(DIALECTS)("a JSON path's depth is bound, not compiled in — %s", (name, dialect) => {
    const shapes = JSON_PATHS[name].map((path) => ({
      where: { metadata: { path, equals: "x" } },
    }));

    const texts = new Set(
      shapes.map(
        (args) =>
          compileRead(userWithProfile, "findMany" as never, args as never, dialect as never).text,
      ),
    );
    const keys = new Set(
      shapes.map((args) => planKey(dialect as never, "User", "findMany" as never, args)),
    );

    expect(texts.size, [...texts].join("\n")).toBe(1);
    expect(keys.size, [...keys].join("\n")).toBe(1);

    // ...and the *filter* beside the path still discriminates, which is the
    // direction a too-eager collapse would break: these are two statements.
    const filterKey = (filter: Record<string, unknown>) =>
      planKey(dialect as never, "User", "findMany" as never, {
        where: { metadata: { path: JSON_PATHS[name][0], ...filter } },
      });
    expect(filterKey({ equals: "x" })).not.toBe(filterKey({ not: "x" }));
    expect(filterKey({ equals: "x" })).not.toBe(filterKey({ string_contains: "x" }));
  });

  /**
   * ...and the other half of that collapse, which the first revision of #301
   * got wrong: **a shape may only be collapsed if every argument it now covers
   * would still be accepted by a cold compile.**
   *
   * `collapsedList` erases the array's elements along with its length, so `[*]`
   * says nothing about what is *in* the path — while `assertPathShape` refuses
   * an array whose segments are not scalars. Collapsed unconditionally, a plan
   * compiled for `["a"]` answered `["a", null]`, `[["a"]]` and `[{ k: 1 }]` off
   * the cache without recompiling, and the refusal never re-ran. `[["a"]]` is
   * the one that matters: it flattens into `{"a"}` and returns the rows for
   * `["a"]`, so the failure is wrong rows rather than a wrong error. It is the
   * `disconnect: true`/`false` trap `plan.ts` documents, arriving from the
   * direction where the *values* are checked rather than the structure.
   *
   * Asserted against `getOrCompile` rather than against `planKey` alone, because
   * a distinct key is the mechanism and "the refusal still fires on a warm
   * cache" is the property. Both are checked: the key comparison says why, the
   * cache run says what.
   */
  const MALFORMED_PATHS: unknown[] = [
    ["a", null],
    ["a", undefined],
    ["a", true],
    [["a"]],
    [{ k: 1 }],
  ];

  test.each(DIALECTS)(
    "a path a cold compile refuses is not served by a warm plan — %s",
    (name, dialect) => {
      const args = (path: unknown) => ({
        where: { metadata: { path, equals: "x" } },
      });
      const good = JSON_PATHS[name][0];
      const goodKey = planKey(dialect as never, "User", "findMany" as never, args(good));

      for (const bad of MALFORMED_PATHS) {
        const label = JSON.stringify(bad);
        // The premise: a cold compile refuses every one of these. Without this
        // the rest of the test would pass vacuously the day the compiler
        // started accepting them.
        expect(
          () =>
            compileRead(userWithProfile, "findMany" as never, args(bad) as never, dialect as never),
          label,
        ).toThrow();
        expect(
          planKey(dialect as never, "User", "findMany" as never, args(bad)),
          label,
        ).not.toBe(goodKey);
      }

      clearPlanCache();
      getOrCompile(userWithProfile, "findMany" as never, args(good), dialect as never);
      for (const bad of MALFORMED_PATHS) {
        expect(() =>
          getOrCompile(userWithProfile, "findMany" as never, args(bad), dialect as never),
          JSON.stringify(bad),
        ).toThrow(/does not support/);
      }
      // None of them reached the warm entry at all — a hit here would mean the
      // plan was returned rather than the argument refused.
      expect(planCacheStats().hits).toBe(0);
    },
  );
});
