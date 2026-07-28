import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { UnsupportedQueryError } from "../errors";
import { account, organization, user } from "../fixtures";
import { applyNestedPolicies, type ModelPolicy } from "../policy";
import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import * as registry from "../registry";
import { compileRead } from "./read";

/**
 * `orderBy: { organization: { name: "asc" } }` — the last thing this compiler
 * said was "not implemented yet".
 *
 * The third use of the same correlated subquery: `exists` for a relation filter,
 * `count(*)` for `_count`, and now a scalar in the `order by` clause. A subquery
 * rather than the `left join` Prisma emits, because a join changes what the
 * `from` clause contains and, on a to-many, the row count. Ordering must not be
 * able to do either.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

function ordering(args: any, dialect = sqlite) {
  const text = compileRead(user, "findMany", args, dialect).text;
  const at = text.indexOf(" order by ");
  return at === -1 ? "" : text.slice(at + " order by ".length);
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

describe("to-one", () => {
  test("by a field of the related row", () => {
    expect(ordering({ orderBy: { organization: { name: "asc" } } })).toBe(
      `(select "_o0"."name" from "Organization" as "_o0" ` +
        `where "_o0"."id" = "User"."organizationId") asc`,
    );
  });

  test("desc, and the long form with nulls", () => {
    expect(
      ordering({
        orderBy: { organization: { name: { sort: "desc", nulls: "last" } } },
      }),
    ).toBe(
      `(select "_o0"."name" from "Organization" as "_o0" ` +
        `where "_o0"."id" = "User"."organizationId") desc nulls last`,
    );
  });

  test("beside a column, in the order written", () => {
    expect(
      ordering({
        orderBy: [{ organization: { name: "asc" } }, { email: "desc" }],
      }),
    ).toBe(
      `(select "_o0"."name" from "Organization" as "_o0" ` +
        `where "_o0"."id" = "User"."organizationId") asc, "email" desc`,
    );
  });

  /** Two relation orderings must not collide on one alias. */
  test("two relation terms get distinct aliases", () => {
    const text = ordering({
      orderBy: [
        { organization: { name: "asc" } },
        { organization: { id: "desc" } },
      ],
    });

    expect(text).toContain(`as "_o0"`);
    expect(text).toContain(`as "_o1"`);
  });
});

describe("to-many", () => {
  test("by _count", () => {
    expect(ordering({ orderBy: { accounts: { _count: "desc" } } })).toBe(
      `(select count(*) from "Account" as "_o0" ` +
        `where "_o0"."userId" = "User"."id") desc`,
    );
  });

  test("ordering a to-many by a field is refused, with the reason", () => {
    expect(() =>
      ordering({ orderBy: { accounts: { organizationRole: "asc" } } }),
    ).toThrow(/no single answer for a parent with several children/);
  });

  test("ordering a to-one by _count is refused", () => {
    expect(() =>
      ordering({ orderBy: { organization: { _count: "asc" } } }),
    ).toThrow(/0 or 1/);
  });
});

describe("pagination and reversal", () => {
  /**
   * A negative `take` flips every term and reverses the page. A relation term
   * has to flip like any other — the direction lives on the term, not inside
   * the expression, which is why `reverse()` needed no special case.
   */
  test("a negative take flips a relation ordering", () => {
    const text = compileRead(
      user,
      "findMany",
      { take: -3, orderBy: { organization: { name: "asc" } } },
      sqlite,
    ).text;

    expect(text).toContain(`) desc`);
    expect(text).not.toContain(`) asc`);
  });
});

describe("what it refuses", () => {
  test("more than one field in one relation node", () => {
    expect(() =>
      ordering({ orderBy: { organization: { name: "asc", id: "asc" } } }),
    ).toThrow(/exactly one field/);
  });

  test("no field at all", () => {
    expect(() => ordering({ orderBy: { organization: {} } })).toThrow(
      /Name the field/,
    );
  });

  test("a field the related model does not have", () => {
    expect(() => ordering({ orderBy: { organization: { nope: "asc" } } })).toThrow(
      /not a field on Organization/,
    );
  });

  test("a direction that is not asc or desc", () => {
    expect(() =>
      ordering({ orderBy: { organization: { name: "sideways" } } }),
    ).toThrow(UnsupportedQueryError);
  });

  test("a scalar where the relation node belongs", () => {
    expect(() => ordering({ orderBy: { organization: "asc" } })).toThrow(
      UnsupportedQueryError,
    );
  });
});

describe("dialects", () => {
  test("postgres quotes and numbers the same way", () => {
    expect(
      ordering({ orderBy: { accounts: { _count: "desc" } } }, postgres),
    ).toBe(
      `(select count(*) from "Account" as "_o0" ` +
        `where "_o0"."userId" = "User"."id") desc`,
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
      organization: { model: "Organization", kind: "one" as const },
    },
  };

  const lookup = (policies: ModelPolicy[]) => (model: string) =>
    model === "Account"
      ? { policies, schema: { name: "Account", relations: {} } }
      : undefined;

  /**
   * Prisma's `orderBy` grammar has no slot for a `where`, so the policy walk
   * adds one and the compiler reads it. Ordering by rows the caller cannot see
   * leaks them by comparison — and by `_count`, outright.
   */
  test("a scope is written into the ordering node", () => {
    const out = applyNestedPolicies(
      root,
      { orderBy: { accounts: { _count: "desc" } } },
      "findMany" as any,
      { organizationId: 7 },
      false,
      lookup([tenant]),
    );

    expect(out.orderBy.accounts).toEqual({
      _count: "desc",
      where: { organizationId: 7 },
    });
  });

  test("the array form is scoped entry by entry", () => {
    const out = applyNestedPolicies(
      root,
      { orderBy: [{ email: "asc" }, { accounts: { _count: "desc" } }] },
      "findMany" as any,
      { organizationId: 7 },
      false,
      lookup([tenant]),
    );

    expect(out.orderBy[0]).toEqual({ email: "asc" });
    expect(out.orderBy[1].accounts.where).toEqual({ organizationId: 7 });
  });

  test("asSystem suspends it", () => {
    const args = { orderBy: { accounts: { _count: "desc" } } };
    expect(
      applyNestedPolicies(
        root,
        args,
        "findMany" as any,
        { organizationId: 7 },
        true,
        lookup([tenant]),
      ),
    ).toBe(args);
  });

  test("an unpolicied ordering is returned unchanged, identically", () => {
    const args = { orderBy: { accounts: { _count: "desc" } } };
    expect(
      applyNestedPolicies(root, args, "findMany" as any, {}, false, lookup([])),
    ).toBe(args);
  });

  /** The scope reaches the SQL, and its value is a parameter. */
  test("the scope lands inside the subquery as a parameter", () => {
    const args = {
      orderBy: { accounts: { _count: "desc", where: { organizationRole: 1 } } },
    };
    const compiled = compileRead(user, "findMany", args, sqlite);

    expect(compiled.text).toContain(
      `where "_o0"."userId" = "User"."id" and "_o0"."organizationRole" = ?`,
    );
    expect(compiled.bind(args)).toEqual([1]);
  });

  test("the array form binds from the right entry", () => {
    const args = {
      orderBy: [
        { email: "asc" },
        { accounts: { _count: "desc", where: { organizationRole: 2 } } },
      ],
    };

    expect(compileRead(user, "findMany", args, sqlite).bind(args)).toEqual([2]);
  });
});
