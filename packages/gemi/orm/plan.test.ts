import { beforeEach, describe, expect, test } from "vitest";

import { SqliteDialect } from "./dialect/sqlite";
import { USER_COLUMNS, user } from "./fixtures";
import {
  canonicalShape,
  clearPlanCache,
  getOrCompile,
  planCacheStats,
  planKey,
} from "./plan";

const sqlite = new SqliteDialect();

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
    expect(planKey("sqlite", "User", "findMany", { where: { id: 1 } })).not.toBe(
      planKey("postgres", "User", "findMany", { where: { id: 1 } }),
    );
    expect(planKey("sqlite", "User", "findMany", {})).not.toBe(
      planKey("sqlite", "Account", "findMany", {}),
    );
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

    expect(planCacheStats()).toEqual({ size: 1, compiles: 1, hits: 1 });
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
