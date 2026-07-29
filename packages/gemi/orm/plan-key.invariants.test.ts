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
import { planKey } from "./plan";
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
const READS: unknown[] = [
  {},
  { where: { id: 1 } },
  { where: { id: 2 } },
  { where: { name: "a" } },
  { where: { name: { contains: "a" } } },
  { where: { name: { startsWith: "a" } } },
  { where: { name: { endsWith: "a" } } },
  { where: { name: { equals: "a" } } },
  { where: { name: { not: "a" } } },
  { where: { id: { gt: 1 } } },
  { where: { id: { gte: 1 } } },
  { where: { id: { lt: 1 } } },
  { where: { id: { lte: 1 } } },
  { where: { id: { in: [1, 2] } } },
  { where: { id: { in: [1, 2, 3] } } },
  { where: { id: { notIn: [1] } } },
  { where: { name: { contains: "a", mode: "insensitive" } } },
  { where: { AND: [{ id: 1 }, { name: "a" }] } },
  { where: { OR: [{ id: 1 }, { name: "a" }] } },
  { where: { NOT: { id: 1 } } },
  { where: { accounts: { some: { id: 1 } } } },
  { where: { accounts: { every: { id: 1 } } } },
  { where: { accounts: { none: { id: 1 } } } },
  { where: { organization: { is: { id: 1 } } } },
  { where: { organization: { isNot: { id: 1 } } } },
  { select: { id: true } },
  { select: { id: true, name: true } },
  { omit: { name: true } },
  { include: { accounts: true } },
  { include: { organization: true } },
  { include: { accounts: { select: { id: true } } } },
  { include: { accounts: { where: { id: 1 } } } },
  { include: { accounts: { take: 2 } } },
  { include: { accounts: { orderBy: { id: "asc" } } } },
  { include: { accounts: { orderBy: { id: "desc" } } } },
  { include: { _count: { select: { accounts: true } } } },
  { orderBy: { id: "asc" } },
  { orderBy: { id: "desc" } },
  { orderBy: { name: { sort: "asc", nulls: "first" } } },
  { orderBy: { name: { sort: "asc", nulls: "last" } } },
  { orderBy: [{ id: "asc" }, { name: "desc" }] },
  { orderBy: { accounts: { _count: "asc" } } },
  { take: 1 },
  { take: 5 },
  { skip: 1 },
  { skip: 1, take: 2 },
];

const WRITES: [string, unknown][] = [
  ["create", { data: { email: "a@b.c" } }],
  ["create", { data: { email: "a@b.c", name: "n" } }],
  ["create", { data: { email: "a@b.c" }, select: { id: true } }],
  [
    "create",
    { data: { email: "a@b.c", accounts: { create: { provider: "p", providerAccountId: "x" } } } },
  ],
  ["create", { data: { email: "a@b.c", organization: { connect: { id: 1 } } } }],
  ["createMany", { data: [{ email: "a@b.c" }] }],
  ["createMany", { data: [{ email: "a@b.c" }, { email: "d@e.f" }] }],
  ["update", { where: { id: 1 }, data: { name: "x" } }],
  ["update", { where: { id: 1 }, data: { globalRole: { increment: 1 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { decrement: 1 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { multiply: 2 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { divide: 2 } } }],
  ["update", { where: { id: 1 }, data: { globalRole: { set: 2 } } }],
  ["update", { where: { id: 1 }, data: { accounts: { connect: { id: 1 } } } }],
  ["update", { where: { id: 1 }, data: { accounts: { disconnect: { id: 1 } } } }],
  ["update", { where: { id: 1 }, data: { accounts: { delete: { id: 1 } } } }],
  ["update", { where: { id: 1 }, data: { accounts: { deleteMany: {} } } }],
  ["updateMany", { where: { id: 1 }, data: { name: "x" } }],
  ["updateMany", { data: { name: "x" } }],
  ["delete", { where: { id: 1 } }],
  ["delete", { where: { id: 1 }, select: { id: true } }],
  // The conflict target has to be set by `create`, or `Model.upsert` runs it as
  // a read and a write instead and there is no single statement to key.
  ["upsert", { where: { email: "a@b.c" }, create: { email: "a@b.c" }, update: { name: "x" } }],
];

const AGGREGATES: unknown[] = [
  { _count: true },
  { _sum: { globalRole: true } },
  { _avg: { globalRole: true } },
  { _min: { globalRole: true } },
  { _max: { globalRole: true } },
  { _count: true, where: { id: 1 } },
  { _count: true, take: 2 },
  { _count: true, skip: 1 },
];

const GROUPS: unknown[] = [
  { by: ["name"], _count: true },
  { by: ["locale"], _count: true },
  { by: ["name", "locale"], _count: true },
  // #92's shape: two thresholds that must share an entry. The grouped column
  // has to be the one filtered on — a `having` on anything else is refused,
  // and an entry that does not compile would test nothing.
  { by: ["globalRole"], _count: true, having: { globalRole: { gt: 1 } } },
  { by: ["globalRole"], _count: true, having: { globalRole: { gt: 200 } } },
  { by: ["name"], _count: true, orderBy: { name: "asc" } },
];

/**
 * The keys whose *values* decide the statement, so a value under one is
 * structural rather than bound. Kept here rather than imported so that
 * widening `LITERAL_KEYS` without thinking does not silently widen this too.
 */
const LITERAL = new Set([
  "orderBy",
  "select",
  "omit",
  "include",
  "distinct",
  "mode",
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
  "by",
  "skipDuplicates",
]);

/** Every scalar that is bound as a parameter, replaced; structure untouched. */
function vary(node: unknown, bound = false): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((entry) => vary(entry, bound));
  if (typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = LITERAL.has(key)
        ? value
        : vary(value, bound || key === "where" || key === "data" || key === "having");
    }
    return out;
  }
  if (!bound) return node;
  if (typeof node === "number") return node + 977;
  if (typeof node === "string") return "ZZZZ";
  return node;
}

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
    sqlite: [/mode: "insensitive"/],
    postgres: [],
  };

  test.each(DIALECTS)("every corpus entry compiles, or is refused by name — %s", (name, dialect) => {
    const { out, refused } = compiled(dialect);

    // A per-parent `take` inside a to-many needs the lateral strategy, and
    // these compile with the default (batched) on both dialects — so it is
    // refused everywhere here, not only on SQLite.
    const expected = [/accounts\.take/, ...EXPECTED_REFUSALS[name]];
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
});
