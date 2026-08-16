import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import { account, membership, organization, user } from "../fixtures";
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

  /**
   * The filter goes through `compileWhere`, so it is a whole `where` and not a
   * column list — a relation filter inside it nests an `exists` correlated to
   * the count's own alias rather than to the outer table.
   *
   * Worth its own test because it is the shape #335 reported and the one every
   * other test here misses: they all filter a scalar, which never exercises the
   * qualifier the correlated alias has to supply. Get that wrong and the inner
   * `exists` correlates to `"User"` instead of `"_c0"` — a count that silently
   * answers a different question rather than failing.
   */
  test("the filter can reach through a relation of the counted model", () => {
    expect(
      projection({
        include: {
          _count: {
            select: { accounts: { where: { organization: { name: "acme" } } } },
          },
        },
      }),
    ).toBe(
      `, (select count(*) from "Account" as "_c0" ` +
        `where "_c0"."userId" = "User"."id" and exists ` +
        `(select 1 from "Organization" as "_r0" ` +
        `where "_r0"."id" = "_c0"."organizationId" and "_r0"."name" = ?)) ` +
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
   * The shorthand on a model with nothing to count.
   *
   * Refused rather than answered with `{}`, and the reason is mechanical rather
   * than stylistic: `resolveSelection` counts `_count` as *something selected*,
   * so `select: { _count: true }` alone would clear its "at least one field"
   * check and then project no columns — `select  from "Membership"`, which the
   * database rejects with a message about neither `_count` nor the model.
   */
  test("the shorthand on a model with no to-many relations", () => {
    expect(() =>
      compileRead(membership, "findMany", { include: { _count: true } }, sqlite),
    ).toThrow(/no to-many relations/);
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

/**
 * `_count: true` — Prisma's "count every to-many relation" (#394).
 *
 * Expanded rather than special-cased, and in two places that must agree:
 * `countableRelations` is what the compiler projects from and what the policy
 * walk scopes, so the set that reaches SQL is the set that carried a scope. The
 * tests below pin both halves of that, because the failure when they drift is a
 * count the reader cannot tell is unscoped — it is a number, not a row.
 */
describe("the bare shorthand", () => {
  test("expands to the explicit form's SQL, exactly", () => {
    expect(projection({ include: { _count: true } })).toBe(
      projection({ include: { _count: { select: { accounts: true } } } }),
    );
  });

  /**
   * The to-one is skipped rather than refused. The explicit form *does* refuse
   * `organization` by name — counting it answers 0 or 1 — but the shorthand
   * named nothing, so there is no argument to report and skipping it is the
   * whole of what Prisma's shorthand means. `user` carries one of each, which is
   * why it is the fixture here.
   */
  test("counts the to-many and skips the to-one", () => {
    const text = plan({ include: { _count: true } }).text;

    expect(text).toContain(`as "_count.accounts"`);
    expect(text).not.toContain(`_count.organization`);
  });

  /**
   * Two to-many relations, declared `users` then `accounts` and projected the
   * other way round. Not cosmetic: the plan cache canonicalises key order, so an
   * expansion that followed declaration order would mint one entry per ordering
   * the schema happens to have.
   */
  test("projects them sorted, not in declaration order", () => {
    const text = compileRead(
      organization,
      "findMany",
      { include: { _count: true } },
      sqlite,
    ).text;

    expect(text.indexOf(`"_count.accounts"`)).toBeLessThan(
      text.indexOf(`"_count.users"`),
    );
  });

  test("select carries it as well as include", () => {
    expect(plan({ select: { id: true, _count: true } }).text).toContain(
      `as "_count.accounts"`,
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

  /**
   * **The shorthand carries the scope too**, and this is the assertion #394
   * turns on. `_count: true` names no relation, so nothing here has a node to
   * hang a scope on until it is expanded — and an unexpanded shorthand reaching
   * the compiler is expanded *there*, where policies are not, so every count
   * would be over rows the caller cannot read. That is the leak the shorthand
   * was refused over, and it returns a number rather than a row: nothing in the
   * response looks wrong.
   */
  test("the shorthand is expanded, then scoped", () => {
    const out = applyNestedPolicies(
      root,
      { include: { _count: true } },
      { organizationId: 7 },
      false,
      lookup([tenant]),
    );

    expect(out.include._count).toEqual({
      select: { accounts: { where: { organizationId: 7 } } },
    });
  });

  /**
   * ...and only then. An unpolicied shorthand stays `true`, so the plan key does
   * not move for the queries this walk has nothing to say about — the same trade
   * the explicit form's test above pins. The compiler expands it either way, so
   * the SQL is identical; what differs is one cache entry versus two.
   */
  test("an unpolicied shorthand is returned unchanged, identically", () => {
    const args = { include: { _count: true } };
    const out = applyNestedPolicies(root, args, {}, false, lookup([]));

    expect(out).toBe(args);
  });

  /**
   * A model with a *mix*: `users` is policied and `accounts` is not. The
   * unpolicied half has to survive the expansion as `true` rather than being
   * dropped, or the shorthand would quietly count fewer relations under a policy
   * than without one.
   */
  test("expanding for one policied relation keeps the others", () => {
    const mixed = {
      relations: {
        users: { model: "User", kind: "many" as const },
        accounts: { model: "Account", kind: "many" as const },
      },
    };

    const out = applyNestedPolicies(
      mixed,
      { include: { _count: true } },
      { organizationId: 7 },
      false,
      (model: string) =>
        model === "User"
          ? { policies: [tenant], schema: { name: "User", relations: {} } }
          : { policies: [], schema: { name: "Account", relations: {} } },
    );

    expect(out.include._count.select).toEqual({
      accounts: true,
      users: { where: { organizationId: 7 } },
    });
  });

  test("asSystem suspends the shorthand as well", () => {
    const args = { include: { _count: true } };
    const out = applyNestedPolicies(
      root,
      args,
      { organizationId: 7 },
      true,
      lookup([tenant]),
    );

    expect(out).toBe(args);
  });
});
