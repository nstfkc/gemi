import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import { account, organization, user } from "../fixtures";
import { applyNestedPolicies, type ModelPolicy } from "../policy";
import * as registry from "../registry";
import { compileRead } from "./read";

/**
 * `_count` on relations — the last thing iteration 3 listed as out of scope and
 * never rescheduled.
 *
 * A correlated `count(*)` in the select list, which is the same machinery
 * relation filters use, projected instead of predicated. The alternatives both
 * change the row set: a join against a to-many duplicates the parents, and a
 * `group by` folds them together.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

function plan(args: any, dialect = sqlite) {
  return compileRead(user, "findMany", args, dialect);
}

/** The projected subquery on its own, which is what these tests are about. */
function projection(args: any, dialect = sqlite) {
  const text = plan(args, dialect).text;
  return text.slice(text.indexOf(", (select count"), text.indexOf(" from \"User\""));
}

beforeEach(() => {
  registry.clearRegistry();
  registry.register("User", class { static $schema = user });
  registry.register("Account", class { static $schema = account });
  registry.register(
    "Organization",
    class {
      static $schema = organization;
    },
  );
});

afterEach(() => {
  registry.clearRegistry();
});

describe("the projected subquery", () => {
  test("one relation, counted", () => {
    expect(
      projection({ include: { _count: { select: { accounts: true } } } }),
    ).toBe(
      `, (select count(*) from "Account" as "_c0" ` +
        `where "_c0"."userId" = "User"."id") as "_count.accounts"`,
    );
  });

  test("a filtered count carries its own where", () => {
    expect(
      projection({
        include: {
          _count: { select: { accounts: { where: { organizationRole: 1 } } } },
        },
      }),
    ).toBe(
      `, (select count(*) from "Account" as "_c0" ` +
        `where "_c0"."userId" = "User"."id" and "_c0"."organizationRole" = ?) ` +
        `as "_count.accounts"`,
    );
  });

  test("the filter's value is a parameter, not text", () => {
    const compiled = plan({
      include: {
        _count: { select: { accounts: { where: { organizationRole: 1 } } } },
      },
    });

    expect(compiled.text).not.toContain("1)");
    expect(
      compiled.bind({
        include: {
          _count: { select: { accounts: { where: { organizationRole: 1 } } } },
        },
      }),
    ).toEqual([1]);
  });

  test("it works inside a select, beside a scalar", () => {
    const text = plan({
      select: { email: true, _count: { select: { accounts: true } } },
    }).text;

    expect(text).toBe(
      `select "email", (select count(*) from "Account" as "_c0" ` +
        `where "_c0"."userId" = "User"."id") as "_count.accounts" from "User"`,
    );
  });

  test("postgres numbers the filter's placeholder", () => {
    expect(
      projection(
        {
          include: {
            _count: { select: { accounts: { where: { organizationRole: 1 } } } },
          },
        },
        postgres,
      ),
    ).toContain("$1");
  });

  /** It is one statement — no second round trip, and no relation plan. */
  test("counting adds no relation query", () => {
    expect(
      plan({ include: { _count: { select: { accounts: true } } } }).relations,
    ).toBeUndefined();
  });

  test("a count beside a real include keeps both", () => {
    const compiled = plan({
      include: { accounts: true, _count: { select: { accounts: true } } },
    });

    expect(compiled.text).toContain("_count.accounts");
    expect(compiled.relations).toHaveLength(1);
  });
});

describe("shaping", () => {
  test("the totals become one object per row", () => {
    const compiled = plan({ include: { _count: { select: { accounts: true } } } });

    const shaped: any = compiled.shape([
      { id: 1, email: "a@b.c", "_count.accounts": 3 },
    ]);

    expect(shaped[0]._count).toEqual({ accounts: 3 });
  });

  /**
   * SQLite hands back a number and Postgres hands back a `bigint` for
   * `count(*)`. Prisma returns a plain number on both, so the coercion belongs
   * here rather than in a caller — and after #56, "the container matters" is not
   * a lesson this codebase needs twice.
   */
  test("a bigint count is coerced to a number", () => {
    const compiled = plan({ include: { _count: { select: { accounts: true } } } });

    const shaped: any = compiled.shape([
      { id: 1, "_count.accounts": 3n },
    ]);

    expect(shaped[0]._count.accounts).toBe(3);
    expect(typeof shaped[0]._count.accounts).toBe("number");
  });

  test("a missing column shapes to zero rather than NaN", () => {
    const compiled = plan({ include: { _count: { select: { accounts: true } } } });

    expect((compiled.shape([{ id: 1 }]) as any)[0]._count).toEqual({
      accounts: 0,
    });
  });
});

describe("what it refuses", () => {
  test("counting a to-one, with the reason", () => {
    expect(() =>
      plan({ include: { _count: { select: { organization: true } } } }),
    ).toThrow(/0 or 1/);
  });

  test("a relation that does not exist", () => {
    expect(() =>
      plan({ include: { _count: { select: { nope: true } } } }),
    ).toThrow(/nope/);
  });

  /**
   * Prisma's `_count: true` counts every to-many relation. Refused rather than
   * approximated: it names no relation, so a policy has nowhere to attach, and
   * what it returns changes when the schema grows a relation.
   */
  test("the bare shorthand, naming the form that works", () => {
    expect(() => plan({ include: { _count: true } })).toThrow(
      /_count: \{ select: \{ <relation>: true \} \}/,
    );
  });

  test("a _count that is not an object", () => {
    expect(() => plan({ include: { _count: 3 } })).toThrow(UnsupportedQueryError);
  });

  test("a _count with no select", () => {
    expect(() => plan({ include: { _count: { accounts: true } } })).toThrow(
      /_count\.select/,
    );
  });
});

describe("policies", () => {
  const tenant: ModelPolicy = {
    scope: (context) => ({
      organizationId: (context.user as any).organizationId,
    }),
    onCreate: (_c, data) => data,
  };

  const root = {
    relations: {
      accounts: { model: "Account", kind: "many" as const },
    },
  };

  const lookup = (policies: ModelPolicy[]) => (model: string) =>
    model === "Account"
      ? { policies, schema: { name: "Account", relations: {} } }
      : undefined;

  /**
   * An unscoped count is the quietest of the three reads that reach another
   * model — it returns a *number*, so what leaks is how many rows exist in
   * tenants the caller cannot see.
   */
  test("the counted relation's scope lands on its node", () => {
    const out = applyNestedPolicies(
      root,
      { include: { _count: { select: { accounts: true } } } },
      { organizationId: 7 },
      false,
      lookup([tenant]),
    );

    expect(out.include._count.select.accounts).toEqual({
      where: { organizationId: 7 },
    });
  });

  test("a filtered count is narrowed, not replaced", () => {
    const out = applyNestedPolicies(
      root,
      {
        include: {
          _count: { select: { accounts: { where: { organizationRole: 1 } } } },
        },
      },
      { organizationId: 7 },
      false,
      lookup([tenant]),
    );

    expect(out.include._count.select.accounts.where).toEqual({
      organizationRole: 1,
      AND: [{ organizationId: 7 }],
    });
  });

  test("asSystem suspends it", () => {
    const args = { include: { _count: { select: { accounts: true } } } };
    const out = applyNestedPolicies(
      root,
      args,
      { organizationId: 7 },
      true,
      lookup([tenant]),
    );

    expect(out).toBe(args);
  });

  /** Structural sharing: an unpolicied count must not move the plan key. */
  test("an unpolicied count is returned unchanged, identically", () => {
    const args = { include: { _count: { select: { accounts: true } } } };
    const out = applyNestedPolicies(
      root,
      args,
      {},
      false,
      lookup([]),
    );

    expect(out).toBe(args);
  });
});
