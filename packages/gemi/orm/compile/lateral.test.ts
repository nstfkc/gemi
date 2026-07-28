import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { account, category, organization, post, tag, user } from "../fixtures";
import * as registry from "../registry";
import { lateralStrategy } from "./lateral";
import { compileRead } from "./read";

/**
 * The lateral strategy — iteration 9's headline deliverable.
 *
 * Two things are being checked, and the second matters more than the first. That
 * the SQL is right, and that **every case it cannot get right falls back** rather
 * than emitting SQL that looks plausible. A strategy that silently returns fewer
 * children than were asked for is worse than one that does not exist.
 */

const postgres = new PostgresDialect();
const sqlite = new SqliteDialect();

beforeEach(() => {
  registry.clearRegistry();
  registry.register("User", class { static $schema = user });
  registry.register("Account", class { static $schema = account });
  registry.register("Organization", class { static $schema = organization });
  registry.register("Post", class { static $schema = post });
  registry.register("Tag", class { static $schema = tag });
});

afterEach(() => registry.clearRegistry());

function compiled(args: any, dialect = postgres) {
  return compileRead(user, "findMany", args, dialect, lateralStrategy);
}

describe("what it emits", () => {
  test("a to-many becomes one statement with a lateral join", () => {
    const plan = compiled({ include: { accounts: true } });

    expect(plan.strategies).toEqual(["lateral"]);
    expect(plan.text).toContain("left join lateral (");
    expect(plan.text).toContain("json_agg(");
    // The correlation is the whole of "lateral": the subquery references the
    // outer row.
    expect(plan.text).toContain(`"Account"."userId" = "User"."id"`);
    // ...and there is exactly one statement, which is the point.
    expect(plan.text.match(/select /g)).toHaveLength(2); // root + subquery
  });

  /**
   * `json_agg` over zero rows returns NULL and an empty to-many must shape to
   * `[]`. This is the single most likely divergence in the strategy.
   */
  test("an empty to-many is coalesced to an empty array", () => {
    expect(compiled({ include: { accounts: true } }).text).toContain(
      `coalesce(json_agg(`,
    );
    expect(compiled({ include: { accounts: true } }).text).toContain(`'[]'::json`);
  });

  test("a to-one does not aggregate and takes one row", () => {
    const plan = compiled({ include: { organization: true } });

    expect(plan.strategies).toEqual(["lateral"]);
    expect(plan.text).not.toContain("json_agg");
    expect(plan.text).toContain("limit 1");
  });

  test("the object's keys are field names, so the JSON arrives shaped", () => {
    const plan = compiled({
      include: { accounts: { select: { id: true, organizationRole: true } } },
    });

    expect(plan.text).toContain(`'id', "Account"."id"`);
    expect(plan.text).toContain(`'organizationRole', "Account"."organizationRole"`);
  });

  test("a node's own where is compiled, and its values stay parameters", () => {
    const args = {
      include: { accounts: { where: { organizationRole: 0 } } },
    };
    const plan = compiled(args);

    expect(plan.text).toContain(`"Account"."organizationRole" = $`);
    // Invariant 2 applies to a strategy's SQL as much as the compiler's own.
    expect(plan.bind(args)).toEqual([0]);
  });

  test("two folded relations get distinct aliases", () => {
    const plan = compiled({
      include: { accounts: true, organization: true },
    });

    expect(plan.text).toContain(`"__lat_accounts"`);
    expect(plan.text).toContain(`"__lat_organization"`);
    expect(plan.strategies).toEqual(["lateral"]);
  });

  test("the root's columns are qualified", () => {
    const plan = compiled({ select: { id: true, accounts: true } });
    expect(plan.text).toContain(`"User"."id"`);
  });
});

/**
 * Every one of these is a correctness boundary rather than a to-do. Falling back
 * per *node* is what lets a mixed tree work, and `strategies` reporting both names
 * is how that stays observable.
 */
describe("folding a whole tree", () => {
  test("a nested include folds into the same statement", () => {
    const plan = compiled({
      include: { accounts: { include: { organization: true } } },
    });

    expect(plan.strategies).toEqual(["lateral"]);
    // One statement, three levels: the point of recursing.
    expect(plan.text.match(/left join lateral/g)).toHaveLength(2);
    // The grandchild's correlation is against its *own* parent, not the root.
    expect(plan.text).toContain(`"Organization"."id" = "Account"."organizationId"`);
    // ...and it arrives as a key on the child's object rather than as a column.
    expect(plan.text).toContain(`'organization', "__lat_organization_1"."data"`);
  });

  test("a relation inside a nested select folds too", () => {
    const plan = compiled({
      include: { accounts: { select: { id: true, organization: true } } },
    });

    expect(plan.strategies).toEqual(["lateral"]);
    expect(plan.text).toContain(`'id', "Account"."id"`);
    expect(plan.text).toContain(`'organization', "__lat_organization_1"."data"`);
    // A `select` that names no other scalar selects no other scalar.
    expect(plan.text).not.toContain(`'publicId', "Account"."publicId"`);
  });

  /**
   * A nested alias carries an index, and this is the case that needs it: without
   * one, the inner `__lat_accounts` would sit inside the outer `__lat_accounts`
   * and silently shadow it.
   */
  test("a tree that reaches the same relation twice gets distinct aliases", () => {
    const plan = compileRead(
      organization,
      "findMany",
      { include: { users: { include: { accounts: { include: { user: true } } } } } },
      postgres,
      lateralStrategy,
    );

    const aliases = [...plan.text.matchAll(/as ("__lat_\w+") on true/g)].map(
      (match) => match[1],
    );
    expect(aliases).toHaveLength(3);
    expect(new Set(aliases).size).toBe(3);
  });

  test("a nested where's values are still parameters, located through the tree", () => {
    const args = {
      include: {
        accounts: { include: { organization: { where: { name: "Acme" } } } },
      },
    };
    const plan = compiled(args);

    expect(plan.text).toContain(`"Organization"."name" = $`);
    expect(plan.bind(args)).toEqual(["Acme"]);
  });

  test("the decoder recurses, so a nested DateTime is a Date too", () => {
    const plan = compiled({
      include: {
        accounts: {
          select: { id: true, organization: { select: { id: true } } },
        },
      },
    });

    const rows = plan.relations![0].root!.decode([
      { id: 1, organization: { id: 9 } },
      { id: 2, organization: null },
    ]) as any[];

    expect(rows[0].organization).toEqual({ id: 9 });
    // A to-one with no row is `null`, not an empty object — the same contract
    // the top level has, one level down.
    expect(rows[1].organization).toBeNull();
  });

  test("the folded subtree is reported, so redaction can walk it", () => {
    const plan = compiled({
      include: { accounts: { include: { organization: true } } },
    });

    expect(plan.relations![0].root!.folded).toEqual([
      { as: "organization", model: "Organization", kind: "one", folded: [] },
    ]);
  });
});

/**
 * Every one of these is a correctness boundary rather than a to-do. Falling back
 * per *node* is what lets a mixed tree work, and `strategies` reporting both names
 * is how that stays observable.
 */
describe("what it declines, falling back to batched", () => {
  test("SQLite declines everything, since its round trips are in-process", () => {
    const plan = compiled({ include: { accounts: true } }, sqlite);

    expect(plan.strategies).toEqual(["batched"]);
    expect(plan.text).not.toContain("lateral");
  });

  test("an implicit many-to-many declines", () => {
    const plan = compileRead(
      post,
      "findMany",
      { include: { tags: true } },
      postgres,
      lateralStrategy,
    );

    expect(plan.strategies).toEqual(["batched"]);
  });

  /**
   * `_count` sits in the same container as the relation nodes and every walk over
   * that container steps past it — so a node carrying one would fold *without* it
   * and return rows missing a key the caller asked for.
   */
  test("a node carrying a _count declines", () => {
    const plan = compiled({
      include: {
        organization: { include: { _count: { select: { users: true } } } },
      },
    });

    expect(plan.strategies).toEqual(["batched"]);
  });

  /**
   * A relation ordering on a node compiles to a correlated subquery, and
   * `foldNode` parses the node's `orderBy` with no `OrderContext` to build one
   * with — so folding it raises rather than emitting anything.
   *
   * The depth-1 case is older than the recursive fold and was already broken:
   * it folded, and threw. What recursion changed is *reach* — a node carrying a
   * nested `include` used to decline for that reason and land on batched, where
   * the ordering works, so making the fold recurse turned a working query into a
   * throwing one. One decline covers both, which is why they are asserted
   * together rather than as a regression and a fix.
   */
  test.each([
    ["by a relation's field", { orderBy: { user: { email: "asc" } } }],
    ["by a relation's count", { orderBy: { user: { _count: "desc" } } }],
    [
      "in the array form",
      { orderBy: [{ organizationRole: "asc" }, { user: { email: "asc" } }] },
    ],
    [
      "beneath a node that would otherwise fold",
      {
        orderBy: { user: { email: "asc" } },
        include: { organization: true },
      },
    ],
  ])("a node ordered %s declines", (_label, node) => {
    const plan = compiled({ include: { accounts: node } });

    expect(plan.strategies).toEqual(["batched"]);
    expect(plan.text).not.toContain("lateral");
  });

  /**
   * ...and an ordering by a *column* still folds, or the decline above would be
   * matching every `orderBy` and nobody would notice.
   */
  test("an ordering by a column is unaffected", () => {
    const plan = compiled({
      include: { accounts: { orderBy: { organizationRole: "desc" } } },
    });

    expect(plan.strategies).toEqual(["lateral"]);
    expect(plan.text).toContain(`order by "Account"."organizationRole" desc`);
  });

  /**
   * The two declines meeting: batching cannot page per parent, so the query is
   * refused rather than run — and the message says which of the two boundaries
   * it hit.
   */
  test("a per-parent page under a relation ordering is refused, not silently batched", () => {
    expect(() =>
      compiled({
        include: { accounts: { orderBy: { user: { email: "asc" } }, take: 2 } },
      }),
    ).toThrow(/declined to fold \(relation ordering on a folded node\)/);
  });

  /**
   * The correlation names both tables, so a relation onto the same table would
   * read `"Category"."parentId" = "Category"."id"` — which inside the subquery
   * compares its own row against itself rather than against the outer one.
   * Expressing it needs an alias in the `from` clause; batching already gets it
   * right.
   */
  test("a self-relation declines", () => {
    registry.register("Category", class { static $schema = category });

    const plan = compileRead(
      category,
      "findMany",
      { include: { children: true } },
      postgres,
      lateralStrategy,
    );

    expect(plan.strategies).toEqual(["batched"]);
  });

  /**
   * Half a fold is not a thing: a folded node's children never enter the related
   * model's `$exec`, so a descendant that cannot be expressed has nowhere to be
   * loaded from. The whole node declines, and the strategy is applied again one
   * level down — so a decline costs one statement, not the subtree.
   */
  test("a descendant that cannot fold declines the whole node", () => {
    const plan = compileRead(
      post,
      "findMany",
      { include: { tags: { include: { posts: true } } } },
      postgres,
      lateralStrategy,
    );

    expect(plan.strategies).toEqual(["batched"]);
  });

  /** A mixed tree: one node folds, the other does not. */
  test("declining is per node, not per query", () => {
    const plan = compileRead(
      post,
      "findMany",
      // `tags` is an implicit m-n and cannot fold; there is nothing else on
      // `Post`, so the mixed tree is built on `User` below.
      { include: { tags: true } },
      postgres,
      lateralStrategy,
    );
    expect(plan.strategies).toEqual(["batched"]);

    const mixed = compiled({
      include: {
        // `organization` carries a `_count` and cannot fold; `accounts` can.
        organization: { include: { _count: { select: { users: true } } } },
        accounts: true,
      },
    });

    expect(mixed.strategies).toEqual(["batched", "lateral"]);
    expect(mixed.text).toContain("left join lateral");
  });
});

/**
 * Per-parent `take` / `skip` — the shape the batched planner refuses, and the
 * reason this strategy exists in the form it does.
 *
 * The trap the SQL has to avoid is a `limit` beside the `json_agg`: that caps the
 * *aggregate's* single row, so it looks like it works and silently returns every
 * child. The page has to be taken before the aggregate, which is why a paginated
 * node gets a subquery the unpaginated one does not.
 */
describe("per-parent pagination", () => {
  test("the limit is inside the page, not beside the aggregate", () => {
    const args = {
      include: { accounts: { take: 10, orderBy: { createdAt: "asc" } } },
    };
    const plan = compiled(args);

    expect(plan.strategies).toEqual(["lateral"]);
    // The page: an inner subquery that limits rows, aggregated afterwards.
    expect(plan.text).toContain(`limit $1) as "__page_accounts"`);
    expect(plan.text).toContain(
      `json_agg("__page_accounts"."data" order by "__page_accounts"."__ord_0" asc)`,
    );
    // The ordering column is carried out of the page so the aggregate can
    // re-apply it — aggregating over an ordered subquery and hoping the order
    // survives is not something Postgres promises.
    expect(plan.text).toContain(`"Account"."createdAt" as "__ord_0"`);
    // A value, so a parameter.
    expect(plan.bind(args)).toEqual([10]);
  });

  test("skip alongside take, and skip on its own", () => {
    const both = { include: { accounts: { take: 5, skip: 2 } } };
    expect(compiled(both).text).toContain("limit $1 offset $2");
    expect(compiled(both).bind(both)).toEqual([5, 2]);

    const only = { include: { accounts: { skip: 4 } } };
    expect(compiled(only).text).toContain("offset $1");
    expect(compiled(only).text).not.toContain("limit");
    expect(compiled(only).bind(only)).toEqual([4]);
  });

  /**
   * Paginating without an `orderBy` orders by the primary key, exactly as the
   * root does. Without it "the first ten per parent" is only meaningful if the
   * scan happens to be stable, which neither dialect promises.
   */
  test("paginating without an orderBy orders by the primary key", () => {
    const plan = compiled({ include: { accounts: { take: 3 } } });
    expect(plan.text).toContain(`"Account"."id" as "__ord_0"`);
    expect(plan.text).toContain(`order by "__ord_0" asc limit $1`);
  });

  /**
   * A negative `take` is "the last N": the page is taken in flipped order and
   * the aggregate puts it back into the caller's. Both orderings are visible in
   * the SQL, which is what makes the two halves checkable separately.
   */
  test("a negative take pages backwards and aggregates forwards", () => {
    const args = {
      include: { accounts: { take: -3, orderBy: { id: "asc" } } },
    };
    const plan = compiled(args);

    expect(plan.text).toContain(`order by "__ord_0" desc limit $1`);
    expect(plan.text).toContain(
      `json_agg("__page_accounts"."data" order by "__page_accounts"."__ord_0" asc)`,
    );
    // `abs`, like the root's pagination — the sign is in the SQL, not the value.
    expect(plan.bind(args)).toEqual([3]);
  });

  test("a node's own where is applied before the page, not after", () => {
    const args = {
      include: { accounts: { take: 2, where: { organizationRole: 0 } } },
    };
    const plan = compiled(args);

    const page = plan.text.slice(plan.text.indexOf("from (select"));
    expect(page).toContain(`"Account"."organizationRole" = $`);
    expect(page.indexOf("organizationRole")).toBeLessThan(page.indexOf("limit"));
    expect(plan.bind(args)).toEqual([0, 2]);
  });

  /**
   * The issue's second acceptance criterion, and the shape the whole thing is
   * for: ten users per organization, one account per user, in one statement.
   */
  test("a per-parent take under another per-parent take", () => {
    const args = {
      include: {
        users: {
          take: 10,
          orderBy: { name: "asc" },
          include: { accounts: { take: 1, orderBy: { createdAt: "desc" } } },
        },
      },
    };
    const plan = compileRead(
      organization,
      "findMany",
      args,
      postgres,
      lateralStrategy,
    );

    expect(plan.strategies).toEqual(["lateral"]);
    expect(plan.text).toContain(`) as "__page_users"`);
    expect(plan.text).toContain(`) as "__page_accounts_1"`);
    // Innermost first, because that is the order the text puts them in — and a
    // mismatch here would page the wrong level by the other's number.
    expect(plan.bind(args)).toEqual([1, 10]);
  });

  test("a to-one is not paginable, and says so as Prisma does", () => {
    expect(() => compiled({ include: { organization: { take: 1 } } })).toThrow(
      /Prisma does not accept 'take' on a to-one relation/,
    );
  });

  test.each([
    ["a non-integer take", { take: 1.5 }, /Expected an integer/],
    ["a take that is not a number", { take: "5" }, /Expected an integer/],
    ["a negative skip", { skip: -1 }, /cannot be negative/],
  ])("%s is refused", (_label, node, message) => {
    expect(() => compiled({ include: { accounts: node } })).toThrow(message);
  });

  /**
   * The refusal, on a strategy that cannot express it. Its message has to name
   * the strategy that *would* work rather than a future release — this is the
   * message #61 holds up as the standard, so all four parts stay: what, why,
   * when, and what to do instead.
   */
  test("declining to fold turns a per-parent page into a refusal", () => {
    expect(() =>
      compileRead(
        post,
        "findMany",
        { include: { tags: { take: 2 } } },
        postgres,
        lateralStrategy,
      ),
    ).toThrow(/declined to fold \(implicit many-to-many\)/);

    // SQLite has no lateral at all, and the message is the same one.
    expect(() =>
      compiled({ include: { accounts: { take: 2 } } }, sqlite),
    ).toThrow(/per parent[\s\S]*lateral join strategy[\s\S]*not postgres/);
  });
});

/**
 * The decoder, which is where the strategy earns or loses its correctness. JSON
 * aggregation flattens types — the batched path never sees that, because its
 * children come back through the driver's own mapping.
 */
describe("decoding the JSON", () => {
  function decode(args: any, value: unknown) {
    const plan = compiled(args);
    return plan.relations![0].root!.decode(value);
  }

  test("a to-many with no rows is an empty array, not null", () => {
    expect(decode({ include: { accounts: true } }, null)).toEqual([]);
    expect(decode({ include: { accounts: true } }, "[]")).toEqual([]);
  });

  test("a to-one with no row is null", () => {
    expect(decode({ include: { organization: true } }, null)).toBeNull();
  });

  test("text and already-parsed JSON both work", () => {
    const asText = decode({ include: { accounts: true } }, '[{"id":1}]') as any[];
    const asObject = decode({ include: { accounts: true } }, [{ id: 1 }]) as any[];

    // Bun's driver parses `jsonb` on some versions and not others; the same
    // `typeof` check the dialect uses handles both without a version test.
    expect(asText[0].id).toBe(1);
    expect(asObject[0].id).toBe(1);
  });

  /**
   * The conversion that would otherwise be silently wrong: `json_build_object`
   * renders a timestamp as ISO text, where the driver would have given a `Date`.
   * Prisma returns a `Date`, so returning the string is a divergence the
   * differential harness would catch only for types the template happens to use.
   */
  test("a DateTime comes back as a Date, not a string", () => {
    const rows = decode(
      { include: { accounts: { select: { id: true, createdAt: true } } } },
      [{ id: 1, createdAt: "2024-01-01T00:00:00.000Z" }],
    ) as any[];

    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows[0].createdAt.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  test("a null DateTime stays null", () => {
    const rows = decode(
      { include: { accounts: { select: { id: true, deletedAt: true } } } },
      [{ id: 1, deletedAt: null }],
    ) as any[];

    expect(rows[0].deletedAt).toBeNull();
  });

  test("fields JSON carries faithfully are left alone", () => {
    const rows = decode(
      { include: { accounts: { select: { id: true, organizationRole: true } } } },
      [{ id: 7, organizationRole: 2 }],
    ) as any[];

    expect(rows[0]).toEqual({ id: 7, organizationRole: 2 });
  });
});

/**
 * A folded relation must not also be loaded — `attachRelations` skips it. The plan
 * carries a `load` that throws rather than the batched loader, so a regression in
 * that skip fails loudly instead of issuing the query the strategy exists to
 * avoid.
 */
describe("the folded plan refuses to be loaded", () => {
  test("load throws, naming the cause", async () => {
    const plan = compiled({ include: { accounts: true } });

    await expect(
      plan.relations![0].load([], {}, {} as any),
    ).rejects.toThrow(/must not also be loaded/);
  });
});
