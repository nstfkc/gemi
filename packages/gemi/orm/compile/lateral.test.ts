import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { account, organization, post, tag, user } from "../fixtures";
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
describe("what it declines, falling back to batched", () => {
  test.each([
    [
      "a node with its own include",
      { include: { accounts: { include: { organization: true } } } },
    ],
    [
      "a node with a relation in its select",
      { include: { accounts: { select: { organization: true } } } },
    ],
  ])("%s", (_label, args) => {
    const plan = compiled(args);

    expect(plan.strategies).toEqual(["batched"]);
    expect(plan.text).not.toContain("lateral");
  });

  /**
   * Pagination on a relation node needs no decline, because the *planner* refuses
   * it before a strategy is consulted. Asserted here so the reason this strategy
   * has no check for it is visible — `json_agg` being an aggregate means a `limit`
   * beside it would cap the aggregate row rather than the children, so if
   * per-relation pagination ever lands, this strategy must decline it.
   */
  test("pagination on a node is refused upstream, so needs no decline here", () => {
    expect(() => compiled({ include: { accounts: { take: 5 } } })).toThrow(
      /take/,
    );
  });

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

  /** A mixed tree: one node folds, the other does not. */
  test("declining is per node, not per query", () => {
    const plan = compiled({
      // `accounts` has a nested include and cannot fold; `organization` can.
      include: {
        accounts: { include: { organization: true } },
        organization: true,
      },
    });

    expect(plan.strategies).toEqual(["batched", "lateral"]);
    expect(plan.text).toContain("left join lateral");
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
