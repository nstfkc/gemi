import { beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "./dialect/postgres";
import * as registry from "./registry";
import { SqliteDialect } from "./dialect/sqlite";
import { USER_COLUMNS, mapped, user } from "./fixtures";
import {
  canonicalShape,
  clearPlanCache,
  getOrCompile,
  planCacheStats,
  planKey,
} from "./plan";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

beforeEach(() => clearPlanCache());

describe("canonicalShape()", () => {
  test("describes the shape, never the values", () => {
    expect(canonicalShape({ where: { email: "a@b.c" } })).toBe(
      canonicalShape({ where: { email: "zzz@qq.dev" } }),
    );
  });

  // Otherwise `{ where: { a, b } }` and `{ where: { b, a } }` compile twice and
  // occupy two cache entries — and, on Postgres, two prepared statements.
  test("is insensitive to key order", () => {
    expect(canonicalShape({ where: { id: 1, email: "x" } })).toBe(
      canonicalShape({ where: { email: "y", id: 2 } }),
    );
  });

  // Prisma treats an explicit `undefined` as "not provided", so a conditional
  // filter must not fork the cache.
  test("drops undefined members", () => {
    expect(canonicalShape({ where: { id: 1, email: undefined } })).toBe(
      canonicalShape({ where: { id: 2 } }),
    );
  });

  // `null` is not a value here, it is a different predicate (`is null`), so it
  // has to stay visible in the shape.
  test("keeps null distinct from a value of the same field", () => {
    expect(canonicalShape({ where: { deletedAt: null } })).not.toBe(
      canonicalShape({ where: { deletedAt: new Date() } }),
    );
  });

  test("distinguishes different key sets", () => {
    expect(canonicalShape({ where: { id: 1 } })).not.toBe(
      canonicalShape({ where: { email: "x" } }),
    );
    expect(canonicalShape({ where: { id: 1 } })).not.toBe(
      canonicalShape({ where: { id: 1 }, take: 2 }),
    );
  });

  test("descends into arrays and nested operators", () => {
    expect(canonicalShape({ where: { id: { in: [1, 2] } } })).toBe(
      canonicalShape({ where: { id: { in: [9, 8] } } }),
    );
    expect(canonicalShape({ where: { id: { in: [1, 2] } } })).not.toBe(
      canonicalShape({ where: { id: { in: [1] } } }),
    );
  });
});

describe("planKey()", () => {
  test("separates dialect, model and operation", () => {
    expect(planKey(sqlite, "User", "findMany", { where: { id: 1 } })).not.toBe(
      planKey(postgres, "User", "findMany", { where: { id: 1 } }),
    );
    expect(planKey(sqlite, "User", "findMany", {})).not.toBe(
      planKey(sqlite, "Account", "findMany", {}),
    );
  });

  // The length of an `in` list is part of the *text* only where the dialect
  // expands it into one placeholder per element. Where it binds as a single
  // parameter, keying on the length mints one entry per distinct length, each
  // holding SQL identical to its neighbours' — which from iteration 3 is one
  // entry per distinct parent row count on every relation query.
  test("an in-list's length is a plan on SQLite and not on Postgres", () => {
    const two = { where: { id: { in: [1, 2] } } };
    const three = { where: { id: { in: [1, 2, 3] } } };

    expect(planKey(sqlite, "User", "findMany", two)).not.toBe(
      planKey(sqlite, "User", "findMany", three),
    );
    expect(planKey(postgres, "User", "findMany", two)).toBe(
      planKey(postgres, "User", "findMany", three),
    );

    // ...and the collapse is exactly as wide as the SQL is identical: an empty
    // list compiles to a constant-false predicate on both dialects.
    expect(planKey(postgres, "User", "findMany", two)).not.toBe(
      planKey(postgres, "User", "findMany", { where: { id: { in: [] } } }),
    );
  });

  test("the collapse does not reach arrays that are structure", () => {
    // `AND: [a, b]` and `AND: [a]` are different predicates on every dialect.
    expect(
      planKey(postgres, "User", "findMany", {
        where: { AND: [{ id: 1 }, { email: "x" }] },
      }),
    ).not.toBe(
      planKey(postgres, "User", "findMany", { where: { AND: [{ id: 1 }] } }),
    );
    expect(
      planKey(postgres, "User", "findMany", {
        orderBy: [{ id: "asc" }, { email: "desc" }],
      }),
    ).not.toBe(
      planKey(postgres, "User", "findMany", { orderBy: [{ id: "asc" }] }),
    );
  });

  test("one Postgres plan serves every in-list length", () => {
    for (const length of [1, 2, 3, 50]) {
      getOrCompile(
        user,
        "findMany",
        { where: { id: { in: Array.from({ length }, (_, i) => i) } } },
        postgres,
      );
    }
    expect(planCacheStats()).toMatchObject({ compiles: 1, size: 1 });
  });
});

describe("the plan cache", () => {
  // The load-bearing property: the same query shape compiles once, no matter
  // how many times it runs or with what values.
  test("compiles once for two calls with the same shape and different values", () => {
    const first = getOrCompile(
      user,
      "findMany",
      { where: { email: "a@b.c" } },
      sqlite,
    );
    const second = getOrCompile(
      user,
      "findMany",
      { where: { email: "zzz@qq.dev" } },
      sqlite,
    );

    expect(planCacheStats()).toMatchObject({ size: 1, compiles: 1, hits: 1 });
    expect(second).toBe(first);
    expect(second.text).toBe(
      `select ${USER_COLUMNS} from "User" where "email" = ?`,
    );

    // One plan, two different parameter arrays — the compile/bind split.
    expect(first.bind({ where: { email: "a@b.c" } })).toEqual(["a@b.c"]);
    expect(first.bind({ where: { email: "zzz@qq.dev" } })).toEqual([
      "zzz@qq.dev",
    ]);
  });

  test("reuses one entry across differing key order", () => {
    getOrCompile(user, "findMany", { where: { id: 1, email: "x" } }, sqlite);
    getOrCompile(user, "findMany", { where: { email: "y", id: 2 } }, sqlite);

    expect(planCacheStats().compiles).toBe(1);
  });

  test("compiles again for a genuinely different shape", () => {
    getOrCompile(user, "findMany", { where: { email: "x" } }, sqlite);
    getOrCompile(user, "findMany", { where: { id: 1 } }, sqlite);

    expect(planCacheStats()).toMatchObject({ size: 2, compiles: 2, hits: 0 });
  });

  test("does not cache a compile that threw", () => {
    expect(() =>
      getOrCompile(user, "findMany", { cursor: { id: 1 } }, sqlite),
    ).toThrow();
    expect(planCacheStats().size).toBe(0);
  });
});

/**
 * **The Json null sentinels are three shapes, not one.**
 *
 * `canonicalShape` records an object by its enumerable entries, and the
 * sentinels have none — so `DbNull`, `JsonNull`, `AnyNull` and a genuine empty
 * Json object all produced `{where:{payload:{equals:{}}}}`. They do not compile
 * alike:
 *
 *     DbNull     "payload" is null
 *     JsonNull   "payload" = ?                          bound 'null'
 *     {}         "payload" = ?                          bound '{}'
 *     AnyNull    ("payload" is null or "payload" = ?)    bound 'null'
 *
 * So the first shape compiled won the entry and every later one was answered
 * with its text: `JsonNull` served `is null` returns the SQL-NULL rows — the
 * other of the two legal nulls, which is the confusion `json-null.ts` exists to
 * prevent — and `DbNull` served `= ?` binds NULL and matches nothing, which is
 * #224 arrived at through the cache rather than through the compiler. That is
 * #266.
 *
 * **Order-dependent, and invisible to a suite that clears the cache between
 * cases.** `differential.test.ts` covers `equals`, bare and `not` for every
 * sentinel and each is correct in isolation; the fault needs two of them to
 * meet in one process. So it is asserted here, in both orders, on the shared
 * cache rather than on the key alone — a key test would pass on a
 * `canonicalShape` that was right while `getOrCompile` reached a stale entry.
 *
 * This is invariant 2 read backwards. `binding.invariants.test.ts` asserts one
 * shape with different values gives byte-identical SQL; the same rule requires
 * different SQL to mean a different shape, and nothing was checking that half.
 */
describe("the Json null sentinels do not share a plan entry", () => {
  const sentinel = (tag: string): object => {
    // A class, for the same reason `json-null.test.ts` spells it out: a method
    // in an object literal is enumerable and `for…in` would walk it, so the
    // recogniser would reject the fake while accepting Prisma's real one.
    class Sentinel {
      toString() {
        return tag;
      }
    }
    return new Sentinel();
  };

  const dbNull = sentinel("Prisma.DbNull");
  const jsonNull = sentinel("Prisma.JsonNull");
  const anyNull = sentinel("Prisma.AnyNull");

  beforeEach(() => {
    registry.clearRegistry();
    registry.register("Mapped", class { static $schema = mapped });
  });

  const textFor = (operand: unknown) =>
    getOrCompile(
      mapped,
      "findMany",
      { where: { payload: { equals: operand } } },
      sqlite,
      "batched",
    ).text;

  const IS_NULL = 'where "payload" is null';
  const EQUALS = 'where "payload" = ?';
  const EITHER = 'where ("payload" is null or "payload" = ?)';

  test("each operand keeps its own key", () => {
    const keys = [dbNull, jsonNull, anyNull, {}].map((operand) =>
      planKey(sqlite, "Mapped", "findMany", {
        where: { payload: { equals: operand } },
      }),
    );

    // `JsonNull` and `{}` are allowed to share *text* — they differ in the
    // bound value, which is what binding is for — but not a key, because the
    // shape is what decides which sentinel the binder will encode.
    expect(new Set(keys).size).toBe(4);
  });

  /**
   * Every ordered pair, because the fault is asymmetric: which one is wrong
   * depends on which compiled first, and a single ordering would have passed
   * for two of the six.
   */
  test.each([
    ["DbNull", dbNull, IS_NULL],
    ["JsonNull", jsonNull, EQUALS],
    ["AnyNull", anyNull, EITHER],
    ["an empty object", {}, EQUALS],
  ] as [string, unknown, string][])(
    "%s compiles to its own text whatever was compiled before it",
    (_label, operand, expected) => {
      for (const first of [dbNull, jsonNull, anyNull, {}]) {
        clearPlanCache();
        textFor(first);
        expect(textFor(operand)).toContain(expected);
      }
    },
  );
});
