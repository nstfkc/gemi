import { beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { user } from "./fixtures";
import {
  clearPlanCache,
  getOrCompile,
  planCacheStats,
  planKey,
} from "./plan";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

beforeEach(() => clearPlanCache());

/**
 * A plan-cache collision does not fail — it silently runs the wrong SQL for the
 * arguments it was handed, which is the worst class of bug this codebase can
 * have. So rather than assert that a handful of shapes differ, this walks a
 * table of shapes that must all be distinct and checks every pair.
 */
const DISTINCT_SHAPES: [string, unknown][] = [
  ["empty", {}],
  ["eq id", { where: { id: 1 } }],
  ["eq email", { where: { email: "x" } }],
  ["eq both", { where: { id: 1, email: "x" } }],
  ["null", { where: { email: null } }],
  ["not null", { where: { email: { not: null } } }],
  ["not value", { where: { email: { not: "x" } } }],

  // Every operator against the same field must be its own entry.
  ["lt", { where: { id: { lt: 1 } } }],
  ["lte", { where: { id: { lte: 1 } } }],
  ["gt", { where: { id: { gt: 1 } } }],
  ["gte", { where: { id: { gte: 1 } } }],
  ["contains", { where: { email: { contains: "x" } } }],
  ["startsWith", { where: { email: { startsWith: "x" } } }],
  ["endsWith", { where: { email: { endsWith: "x" } } }],

  // The in-length case: on SQLite these are three different SQL texts.
  ["in 1", { where: { id: { in: [1] } } }],
  ["in 2", { where: { id: { in: [1, 2] } } }],
  ["in 3", { where: { id: { in: [1, 2, 3] } } }],
  ["notIn 2", { where: { id: { notIn: [1, 2] } } }],

  // Direction and field are both structural.
  ["order id asc", { orderBy: { id: "asc" } }],
  ["order id desc", { orderBy: { id: "desc" } }],
  ["order name asc", { orderBy: { name: "asc" } }],
  ["order nulls first", { orderBy: { name: { sort: "asc", nulls: "first" } } }],
  ["order nulls last", { orderBy: { name: { sort: "asc", nulls: "last" } } }],
  ["order two", { orderBy: [{ name: "asc" }, { id: "desc" }] }],
  ["order two reversed", { orderBy: [{ id: "desc" }, { name: "asc" }] }],

  // Pagination changes the clause set, and a negative take changes the order.
  ["take", { take: 1 }],
  ["skip", { skip: 1 }],
  ["take and skip", { take: 1, skip: 1 }],
  ["negative take", { take: -1 }],

  // Different selections are different column lists.
  ["select id", { select: { id: true } }],
  ["select email", { select: { email: true } }],
  ["select both", { select: { id: true, email: true } }],

  ["NOT", { where: { NOT: { id: 1 } } }],
];

describe("plan cache discrimination", () => {
  test("every shape in the table gets its own key", () => {
    const keys = new Map<string, string>();
    for (const [label, args] of DISTINCT_SHAPES) {
      const key = planKey(sqlite, "User", "findMany", args);
      const clash = keys.get(key);
      expect(clash, `"${label}" collides with "${clash}"`).toBeUndefined();
      keys.set(key, label);
    }
    expect(keys.size).toBe(DISTINCT_SHAPES.length);
  });

  // The key is only half of it. Two shapes hashing apart but compiling to the
  // same *plan* would mean the extra entries buy nothing; two shapes hashing
  // together and compiling differently is the dangerous direction.
  //
  // A plan is the text *and* its binders, not the text alone: `contains`,
  // `startsWith` and `endsWith` all emit `"email" like ?` and differ only in
  // the wildcards the binder wraps around the value — which is exactly where
  // the wildcards belong.
  test("every shape in the table produces its own plan", () => {
    const plans = new Map<string, string>();
    for (const [label, args] of DISTINCT_SHAPES) {
      const plan = getOrCompile(user, "findMany", args, sqlite);
      const identity = `${plan.text} ${JSON.stringify(plan.bind(args))}`;
      const clash = plans.get(identity);
      expect(
        clash,
        `"${label}" is indistinguishable from "${clash}":\n  ${identity}`,
      ).toBeUndefined();
      plans.set(identity, label);
    }
  });

  // The benign duplicates: several distinct argument objects mean "no filter",
  // so they share a plan while getting their own cache keys. The cost is a
  // spare entry, never a wrong plan — but it is worth pinning, so that a future
  // change to `canonicalShape` cannot turn it into the dangerous direction
  // without a test noticing.
  const VACUOUS: [string, unknown][] = [
    ["no args", undefined],
    ["empty object", {}],
    ["empty where", { where: {} }],
    // An empty AND is vacuously true — Prisma's semantics, verified.
    ["empty AND", { where: { AND: [] } }],
  ];

  test("shapes that mean 'no filter' share a plan but not a key", () => {
    const base = getOrCompile(user, "findMany", {}, sqlite).text;
    const keys = new Set<string>();

    for (const [label, args] of VACUOUS) {
      expect(getOrCompile(user, "findMany", args, sqlite).text, label).toBe(
        base,
      );
      keys.add(planKey(sqlite, "User", "findMany", args));
    }

    expect(keys.size).toBe(VACUOUS.length);
  });

  // The other benign group, for the same reason: several ways of saying "match
  // nothing" all reduce to a constant-false predicate.
  const NEVER_MATCHES: [string, unknown][] = [
    ["empty OR", { where: { OR: [] } }],
    ["empty in", { where: { id: { in: [] } } }],
  ];

  test("shapes that match nothing share a plan but not a key", () => {
    const keys = new Set<string>();
    for (const [label, args] of NEVER_MATCHES) {
      const plan = getOrCompile(user, "findMany", args, sqlite);
      expect(plan.text, label).toMatch(/where false$/);
      expect(plan.bind(args), label).toEqual([]);
      keys.add(planKey(sqlite, "User", "findMany", args));
    }
    expect(keys.size).toBe(NEVER_MATCHES.length);
  });

  // `take: 10` and `take: 20` are the same query with different parameters, so
  // they must share a plan — the magnitude is bound, only the sign is
  // structural.
  test("take magnitude shares a plan but take sign does not", () => {
    expect(planKey(sqlite, "User", "findMany", { take: 10 })).toBe(
      planKey(sqlite, "User", "findMany", { take: 20 }),
    );
    expect(planKey(sqlite, "User", "findMany", { take: 10 })).not.toBe(
      planKey(sqlite, "User", "findMany", { take: -10 }),
    );
  });

  test("the operation is part of the key", () => {
    const args = { where: { id: 1 } };
    const keys = new Set(
      (["findMany", "findFirst", "findUnique", "count"] as const).map((op) =>
        planKey(sqlite, "User", op, args),
      ),
    );
    expect(keys.size).toBe(4);
  });

  test("the dialect is part of the key", () => {
    const args = { where: { id: { in: [1, 2] } } };
    expect(planKey(sqlite, "User", "findMany", args)).not.toBe(
      planKey(postgres, "User", "findMany", args),
    );

    // ...and they really do compile differently, which is why they must not
    // share an entry: SQLite expands the list, Postgres binds an array.
    expect(getOrCompile(user, "findMany", args, sqlite).text).not.toBe(
      getOrCompile(user, "findMany", args, postgres).text,
    );
  });

  // Postgres is the exception that proves the point: there, every in-length
  // shares one SQL text on purpose — so it shares one cache entry too, and the
  // extra entries are the cost of SQLite's expansion rather than a fact about
  // `in` lists. `planKey` asks the dialect which it is.
  test("postgres compiles every in-length to one text, under one key", () => {
    const texts = new Set(
      [[1], [1, 2], [1, 2, 3]].map(
        (values) =>
          getOrCompile(user, "findMany", { where: { id: { in: values } } }, postgres)
            .text,
      ),
    );
    expect(texts.size).toBe(1);
    expect(planCacheStats()).toMatchObject({ compiles: 1, size: 1 });
  });
});

/**
 * Acceptance criterion: not one value is inlined into the SQL text anywhere.
 *
 * The check is that no digit survives outside an identifier — identifiers are
 * quoted, so stripping quoted spans and then looking for a digit finds any
 * number that reached the text. `limit`, `offset`, `in` lists and boolean
 * constants are the four places it would be tempting.
 */
describe("no value ever reaches the SQL text", () => {
  const VALUE_BEARING: [string, unknown][] = [
    ["take", { take: 10 }],
    ["skip", { skip: 25 }],
    ["take and skip", { take: 10, skip: 25 }],
    ["negative take", { take: -10 }],
    ["equality", { where: { id: 42 } }],
    ["in", { where: { id: { in: [1, 2, 3] } } }],
    ["empty in", { where: { id: { in: [] } } }],
    ["empty OR", { where: { OR: [] } }],
    ["comparison", { where: { id: { gte: 7 } } }],
    ["contains", { where: { email: { contains: "9" } } }],
    ["date", { where: { createdAt: new Date(1772093271771) } }],
    ["everything", {
      where: { id: { gte: 7 }, email: { contains: "5" } },
      orderBy: { id: "desc" },
      take: 3,
      skip: 6,
    }],
  ];

  test.each(VALUE_BEARING)("%s — sqlite", (_label, args) => {
    expect(stripIdentifiers(getOrCompile(user, "findMany", args, sqlite).text))
      .not.toMatch(/\d/);
  });

  test.each(VALUE_BEARING)("%s — postgres", (_label, args) => {
    // Postgres placeholders are `$1`, `$2`, ... so those are stripped too —
    // they are parameter markers, which is precisely the point.
    const text = getOrCompile(user, "findMany", args, postgres).text;
    expect(stripIdentifiers(text).replace(/\$\d+/g, "")).not.toMatch(/\d/);
  });
});

function stripIdentifiers(text: string): string {
  return text.replace(/"(?:[^"]|"")*"/g, "");
}

/**
 * The key space is finite per application in every dimension but one: on SQLite
 * an `in` list expands to one placeholder per element, so each distinct length
 * is its own plan — and length is routinely request-derived. Unbounded, that is
 * a slow memory leak reachable from untrusted input.
 */
describe("the plan cache is bounded", () => {
  test("evicts rather than growing without limit", () => {
    const { capacity } = planCacheStats();

    // One distinct `in` length per iteration, the way a `?ids=` query parameter
    // would produce them.
    for (let length = 1; length <= capacity + 50; length++) {
      getOrCompile(
        user,
        "findMany",
        { where: { id: { in: Array.from({ length }, (_, i) => i) } } },
        sqlite,
      );
    }

    const stats = planCacheStats();
    expect(stats.size).toBeLessThanOrEqual(capacity);
    expect(stats.evictions).toBeGreaterThan(0);
  });

  // A hot shape must survive a flood of one-off ones, or the cache would be
  // worse than useless under exactly the traffic that fills it.
  test("keeps a repeatedly-used plan and drops the cold ones", () => {
    const { capacity } = planCacheStats();
    const hot = { where: { email: "x" } };
    const first = getOrCompile(user, "findMany", hot, sqlite);

    for (let length = 1; length <= capacity + 50; length++) {
      getOrCompile(
        user,
        "findMany",
        { where: { id: { in: Array.from({ length }, (_, i) => i) } } },
        sqlite,
      );
      // Touching the hot shape keeps it at the head of the LRU order.
      getOrCompile(user, "findMany", hot, sqlite);
    }

    expect(getOrCompile(user, "findMany", hot, sqlite)).toBe(first);
  });
});

/**
 * `select` and `include` are structural, so their contents go into the key
 * verbatim — but a `where` nested inside one holds filter *values* again.
 * Recording those would put user data into a long-lived global map and give
 * every distinct value its own entry.
 */
describe("structural keying stops at a value boundary", () => {
  test("a nested where does not leak its values into the key", () => {
    const a = planKey(sqlite, "User", "findMany", {
      include: { accounts: { where: { publicId: "secret-value" } } },
    });
    const b = planKey(sqlite, "User", "findMany", {
      include: { accounts: { where: { publicId: "another-value" } } },
    });

    expect(a).toBe(b);
    expect(a).not.toContain("secret-value");
  });

  test("but the structural part of a nested selection still discriminates", () => {
    expect(
      planKey(sqlite, "User", "findMany", {
        include: { accounts: { orderBy: { id: "asc" } } },
      }),
    ).not.toBe(
      planKey(sqlite, "User", "findMany", {
        include: { accounts: { orderBy: { id: "desc" } } },
      }),
    );
  });
});
