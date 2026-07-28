import { beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { account, organization, user } from "./fixtures";
import * as registry from "./registry";
import {
  clearPlanCache,
  getOrCompile,
  planCacheStats,
  planKey,
} from "./plan";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

beforeEach(() => {
  clearPlanCache();
  // The relation shapes below resolve their target through the registry, the
  // same way every relation does.
  registry.clearRegistry();
  registry.register("User", class { static $schema = user });
  registry.register("Account", class { static $schema = account });
  registry.register("Organization", class { static $schema = organization });
});

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

  // --- relation filters ---------------------------------------------------
  //
  // Each operator is its own SQL: `some` is `exists`, `none` is `not exists`,
  // and `every` is `not exists` over the *negated* condition. Sharing a plan
  // between any two of them would answer a different question than the caller
  // asked, and `every` against `some` would answer close to the opposite one.
  ["some empty", { where: { accounts: { some: {} } } }],
  ["some filtered", { where: { accounts: { some: { organizationRole: 1 } } } }],
  ["none empty", { where: { accounts: { none: {} } } }],
  ["none filtered", { where: { accounts: { none: { organizationRole: 1 } } } }],
  ["every filtered", { where: { accounts: { every: { organizationRole: 1 } } } }],
  ["two operators", {
    where: { accounts: { some: {}, none: { organizationRole: 1 } } },
  }],
  ["to-one shorthand", { where: { organization: { name: "x" } } }],
  ["to-one isNot", { where: { organization: { isNot: { name: "x" } } } }],
  ["to-one is null", { where: { organization: null } }],
  ["to-one isNot null", { where: { organization: { isNot: null } } }],
  ["nested relation filter", {
    where: { accounts: { some: { organization: { name: "x" } } } },
  }],

  // --- _count -------------------------------------------------------------
  //
  // The relations named decide the projected columns, and a filtered count adds
  // a predicate inside the subquery.
  ["count accounts", { include: { _count: { select: { accounts: true } } } }],
  ["count filtered", {
    include: {
      _count: { select: { accounts: { where: { organizationRole: 1 } } } },
    },
  }],
  ["count in select", { select: { _count: { select: { accounts: true } } } }],
  ["count beside an include", {
    include: { accounts: true, _count: { select: { accounts: true } } },
  }],

  // --- ordering by a relation ---------------------------------------------
  ["order by relation field", { orderBy: { organization: { name: "asc" } } }],
  ["order by relation field desc", { orderBy: { organization: { name: "desc" } } }],
  ["order by relation id", { orderBy: { organization: { id: "asc" } } }],
  ["order by count", { orderBy: { accounts: { _count: "desc" } } }],
  ["order by count asc", { orderBy: { accounts: { _count: "asc" } } }],
  // What the policy walk writes into an ordering node — the key is not in
  // Prisma's grammar and only that walk produces it, but it changes the SQL and
  // so must change the plan.
  ["order by count, scoped", {
    orderBy: { accounts: { _count: "desc", where: { organizationRole: 1 } } },
  }],
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
  // A plan is the text, its binders **and its relation list** — not the text
  // alone: `contains`, `startsWith` and `endsWith` all emit `"email" like ?`
  // and differ only in the wildcards the binder wraps around the value, which
  // is exactly where the wildcards belong.
  //
  // The relation list joined that sentence when `_count` arrived. A batched
  // relation contributes *no root column* — it is a separate query — so
  // `include: { accounts: true, _count: … }` and `include: { _count: … }`
  // compile to the same root statement and differ only in what runs afterwards.
  // Comparing text and binders alone reported that as a collision, which it is
  // not: the keys differ, and so do the plans. The identity was too narrow, not
  // the cache too coarse.
  const identityOf = (plan: ReturnType<typeof getOrCompile>, args: unknown) =>
    [
      plan.text,
      JSON.stringify(plan.bind(args)),
      JSON.stringify(
        (plan.relations ?? []).map((relation) => [
          relation.as,
          relation.model,
          relation.kind,
          relation.strategy,
          relation.root !== undefined,
        ]),
      ),
    ].join(" ");

  test("every shape in the table produces its own plan", () => {
    const plans = new Map<string, string>();
    for (const [label, args] of DISTINCT_SHAPES) {
      const plan = getOrCompile(user, "findMany", args, sqlite);
      const identity = identityOf(plan, args);
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

/**
 * The other direction, and the one the plan document calls out as dangerous:
 * two callers whose arguments differ only in *values* must share a plan, and
 * two whose scopes differ in *shape* must not.
 *
 * This matters most on the surfaces where a **policy** writes the argument.
 * Iteration 6 established it for a root `where`; relation filters, `_count` and
 * relation orderings each put a policy's fragment somewhere new, and each is
 * one more place where "same shape, different tenant" has to mean one plan and
 * "different shape" has to mean two. Getting the first wrong is a cache that
 * never hits; getting the second wrong is one tenant running another's SQL.
 */
describe("policy-written arguments key on shape, not on value", () => {
  const shared: [string, unknown, unknown][] = [
    [
      "a relation filter's scope",
      { where: { accounts: { some: { organizationRole: 1 } } } },
      { where: { accounts: { some: { organizationRole: 2 } } } },
    ],
    [
      "a filtered _count",
      {
        include: {
          _count: { select: { accounts: { where: { organizationRole: 1 } } } },
        },
      },
      {
        include: {
          _count: { select: { accounts: { where: { organizationRole: 9 } } } },
        },
      },
    ],
    [
      "a scoped relation ordering",
      { orderBy: { accounts: { _count: "desc", where: { organizationRole: 1 } } } },
      { orderBy: { accounts: { _count: "desc", where: { organizationRole: 9 } } } },
    ],
  ];

  test.each(shared)("%s: two values, one plan", (_label, mine, theirs) => {
    expect(planKey(sqlite, "User", "findMany", mine)).toBe(
      planKey(sqlite, "User", "findMany", theirs),
    );

    clearPlanCache();
    getOrCompile(user, "findMany", mine, sqlite);
    getOrCompile(user, "findMany", theirs, sqlite);
    expect(planCacheStats().compiles).toBe(1);
    expect(planCacheStats().hits).toBe(1);
  });

  const distinct: [string, unknown, unknown][] = [
    [
      "a relation filter scoped on a different column",
      { where: { accounts: { some: { organizationRole: 1 } } } },
      { where: { accounts: { some: { userId: 1 } } } },
    ],
    [
      "a _count scoped and unscoped",
      { include: { _count: { select: { accounts: true } } } },
      {
        include: {
          _count: { select: { accounts: { where: { organizationRole: 1 } } } },
        },
      },
    ],
    [
      "an ordering scoped and unscoped",
      { orderBy: { accounts: { _count: "desc" } } },
      { orderBy: { accounts: { _count: "desc", where: { organizationRole: 1 } } } },
    ],
  ];

  test.each(distinct)("%s: two plans", (_label, mine, theirs) => {
    expect(planKey(sqlite, "User", "findMany", mine)).not.toBe(
      planKey(sqlite, "User", "findMany", theirs),
    );
    expect(getOrCompile(user, "findMany", mine, sqlite).text).not.toBe(
      getOrCompile(user, "findMany", theirs, sqlite).text,
    );
  });

  /** And the dialect is in the key, as it is for every other shape. */
  test("the two dialects do not share a relation-filter plan", () => {
    const args = { where: { accounts: { some: { organizationRole: 1 } } } };
    expect(planKey(sqlite, "User", "findMany", args)).not.toBe(
      planKey(postgres, "User", "findMany", args),
    );
  });
});
