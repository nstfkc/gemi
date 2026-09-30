import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import {
  InvalidArgumentError,
  UnsupportedByDesignError,
  UnsupportedQueryError,
} from "../errors";
import { account, organization, user } from "../fixtures";
import { clearPlanCache, getOrCompile, planKey, type Operation } from "../plan";
import * as registry from "../registry";
import { lateralStrategy } from "./lateral";
import { parseRowLock } from "./lock";
import { compileRead } from "./read";

/**
 * `lock` on a read (#627): what it compiles to, what it refuses, and that the
 * plan cache keeps two locks apart.
 *
 * The runtime half — that the lock is actually held, and that `skipLocked` and
 * `noWait` do what they say against a second transaction — needs a server and
 * lives in the template's `row-locks.test.ts`.
 */

const postgres = new PostgresDialect();
const sqlite = new SqliteDialect();

beforeEach(() => {
  clearPlanCache();
  registry.clearRegistry();
  registry.register(
    "User",
    class {
      static $schema = user;
    },
  );
  registry.register(
    "Account",
    class {
      static $schema = account;
    },
  );
  registry.register(
    "Organization",
    class {
      static $schema = organization;
    },
  );
});

afterEach(() => registry.clearRegistry());

const LOCKING_READS: Operation[] = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
];

function text(op: Operation, args: any, dialect = postgres) {
  return compileRead(user, op, args, dialect).text;
}

describe("postgres", () => {
  test.each(LOCKING_READS)("%s ends with the lock clause", (op) => {
    const statement = text(op, { where: { id: 1 }, lock: "update" });
    expect(statement.endsWith(` for update of "User"`)).toBe(true);
  });

  test("each form spells its clause", () => {
    const where = { id: 1 };
    expect(text("findUnique", { where, lock: "share" })).toMatch(
      / for share of "User"$/,
    );
    expect(
      text("findUnique", { where, lock: { mode: "update", skipLocked: true } }),
    ).toMatch(/ for update of "User" skip locked$/);
    expect(
      text("findUnique", { where, lock: { mode: "share", noWait: true } }),
    ).toMatch(/ for share of "User" nowait$/);
    // `false` is the same as leaving it out.
    expect(
      text("findUnique", {
        where,
        lock: { mode: "update", skipLocked: false, noWait: false },
      }),
    ).toMatch(/ for update of "User"$/);
  });

  test("the lock comes after order by, limit and offset", () => {
    const statement = text("findMany", {
      where: { email: { startsWith: "a" } },
      orderBy: { id: "asc" },
      take: 5,
      skip: 2,
      lock: { mode: "update", skipLocked: true },
    });

    expect(statement).toMatch(
      /order by "id" asc limit \$\d+ offset \$\d+ for update of "User" skip locked$/,
    );
  });

  test("the lock adds no parameter", () => {
    const plain = compileRead(user, "findMany", { where: { id: 1 } }, postgres);
    const locked = compileRead(
      user,
      "findMany",
      { where: { id: 1 }, lock: "update" },
      postgres,
    );
    expect(locked.text.startsWith(plain.text)).toBe(true);
  });

  test("a folded include locks the root table only", () => {
    // `for update` without `of` would ask Postgres to lock through the lateral
    // subquery, which it refuses because the subquery aggregates.
    const statement = compileRead(
      user,
      "findMany",
      { include: { accounts: true }, lock: "update" },
      postgres,
      lateralStrategy,
    ).text;

    expect(statement).toContain("left join lateral (");
    expect(statement).toMatch(/ for update of "User"$/);
  });

  test("select narrows the columns and keeps the lock", () => {
    const statement = text("findUnique", {
      where: { id: 1 },
      select: { id: true, email: true },
      lock: "update",
    });
    expect(statement).toBe(
      `select "id", "email" from "User" where "id" = $1 limit $2 for update of "User"`,
    );
  });
});

describe("sqlite", () => {
  test.each(LOCKING_READS)(
    "%s compiles to the same statement as without it",
    (op) => {
      const where = { id: 1 };
      expect(text(op, { where, lock: "update" }, sqlite)).toBe(
        text(op, { where }, sqlite),
      );
    },
  );

  test("the value is still validated, so a typo fails in development", () => {
    expect(() => text("findMany", { lock: "updaet" }, sqlite)).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("refusals", () => {
  test.each([
    ["an unknown mode", "exclusive"],
    ["null", null],
    ["a boolean", true],
    ["an array", ["update"]],
    ["an object without a mode", { skipLocked: true }],
    ["an unknown key", { mode: "update", wait: false }],
    ["a non-boolean flag", { mode: "update", skipLocked: "yes" }],
  ])("%s", (_label, lock) => {
    expect(() => parseRowLock(lock, "User", "findMany")).toThrow(
      InvalidArgumentError,
    );
  });

  test("skipLocked and noWait together", () => {
    expect(() =>
      parseRowLock(
        { mode: "update", skipLocked: true, noWait: true },
        "User",
        "findMany",
      ),
    ).toThrow(/cannot both be set/);
  });

  test("count does not take a lock", () => {
    expect(() =>
      compileRead(user, "count", { lock: "update" }, postgres),
    ).toThrow(UnsupportedQueryError);
  });

  test("a relation node does not take a lock, and says why", () => {
    const attempt = () =>
      compileRead(
        user,
        "findMany",
        { include: { accounts: { lock: "update" } } },
        postgres,
      );
    expect(attempt).toThrow(UnsupportedByDesignError);
    expect(attempt).toThrow(/not an included relation's/);
  });
});

describe("the plan cache", () => {
  const where = { id: 1 };
  const locks = [
    undefined,
    "update",
    "share",
    { mode: "update", skipLocked: true },
    { mode: "update", noWait: true },
    { mode: "share", skipLocked: true },
  ];

  test("every lock is its own plan key, on both dialects", () => {
    for (const dialect of [postgres, sqlite]) {
      const keys = locks.map((lock) =>
        planKey(dialect, "User", "findUnique", { where, lock }),
      );
      expect(new Set(keys).size).toBe(locks.length);
    }
  });

  test("the key does not depend on the order of the lock's keys", () => {
    expect(
      planKey(postgres, "User", "findMany", {
        lock: { mode: "update", skipLocked: true },
      }),
    ).toBe(
      planKey(postgres, "User", "findMany", {
        lock: { skipLocked: true, mode: "update" },
      }),
    );
  });

  test("a cached plain read is never served to a locking one", () => {
    const plain = getOrCompile(user, "findUnique", { where }, postgres);
    const update = getOrCompile(
      user,
      "findUnique",
      { where, lock: "update" },
      postgres,
    );
    const share = getOrCompile(
      user,
      "findUnique",
      { where, lock: "share" },
      postgres,
    );

    expect(plain.text).not.toContain(" for ");
    expect(update.text).toMatch(/for update of "User"$/);
    expect(share.text).toMatch(/for share of "User"$/);
  });

  test("a column called `lock` in a where stays a bound value", () => {
    // `lock` is read from the root of the arguments only. Were it a
    // `LITERAL_KEYS` entry, this value would be recorded verbatim in the key.
    const a = planKey(postgres, "User", "findMany", {
      where: { lock: "a" },
    });
    const b = planKey(postgres, "User", "findMany", {
      where: { lock: "b" },
    });
    expect(a).toBe(b);
  });
});
