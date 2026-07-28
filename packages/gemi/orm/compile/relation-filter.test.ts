import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import { account, organization, user } from "../fixtures";
import * as registry from "../registry";
import { compileRead } from "./read";

/**
 * `where: { accounts: { some: … } }` — the follow-up iteration 3 scheduled and
 * nobody picked up.
 *
 * > **Relation filters in `where`** … are not relation *loading* and do not
 * > belong here — they compile to `EXISTS (SELECT 1 ...)` subqueries in the
 * > where compiler. They are cheap to add and often assumed present.
 * > — `plans/orm/03-motorcycle-relations.md`
 *
 * The text assertions are the point of this file. A relation filter is the first
 * thing in the where compiler that emits a whole statement rather than a
 * predicate, so "does it round-trip through Prisma" (the differential suite's
 * job) is not enough on its own — the *shape* of the subquery is where the
 * mistakes are, and they are the kind that still return plausible rows.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

function text(args: any, dialect = sqlite) {
  return compileRead(user, "findMany", args, dialect).text;
}

/** Just the predicate, which is what these tests are actually about. */
function predicate(args: any, dialect = sqlite) {
  const compiled = text(args, dialect);
  const at = compiled.indexOf(" where ");
  return at === -1 ? "" : compiled.slice(at + " where ".length);
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

describe("to-many", () => {
  test("some, with a filter", () => {
    expect(predicate({ where: { accounts: { some: { organizationRole: "owner" } } } }))
      .toBe(
        `exists (select 1 from "Account" as "_r0" ` +
          `where "_r0"."userId" = "User"."id" and "_r0"."organizationRole" = ?)`,
      );
  });

  /** No inner condition at all: "has at least one". */
  test("some, empty", () => {
    expect(predicate({ where: { accounts: { some: {} } } })).toBe(
      `exists (select 1 from "Account" as "_r0" where "_r0"."userId" = "User"."id")`,
    );
  });

  test("none is the same subquery, negated", () => {
    expect(predicate({ where: { accounts: { none: {} } } })).toBe(
      `not exists (select 1 from "Account" as "_r0" where "_r0"."userId" = "User"."id")`,
    );
  });

  /**
   * `every` is "no child fails it" rather than "some child passes it". The two
   * differ on a parent with **no children at all**, which `every` matches and
   * `some` does not — so it has to be a negated existence over the negated
   * condition, not an existence over the condition.
   */
  test("every is not exists over the negation", () => {
    expect(predicate({ where: { accounts: { every: { organizationRole: "owner" } } } }))
      .toBe(
        `not exists (select 1 from "Account" as "_r0" ` +
          `where "_r0"."userId" = "User"."id" and not ("_r0"."organizationRole" = ?))`,
      );
  });

  /** `every: {}` is true of every row, including rows with no children. */
  test("every with an empty filter constrains nothing", () => {
    expect(text({ where: { accounts: { every: {} } } })).not.toContain("exists");
  });

  test("two operators on one relation are ANDed", () => {
    expect(
      predicate({
        where: { accounts: { some: { organizationRole: "owner" }, none: { organizationRole: "member" } } },
      }),
    ).toBe(
      `(not exists (select 1 from "Account" as "_r0" ` +
        `where "_r0"."userId" = "User"."id" and "_r0"."organizationRole" = ?) and ` +
        `exists (select 1 from "Account" as "_r0" ` +
        `where "_r0"."userId" = "User"."id" and "_r0"."organizationRole" = ?))`,
    );
  });
});

describe("to-one", () => {
  /** The shorthand: no `is`, the object *is* the filter. */
  test("a bare object filters the related row", () => {
    expect(predicate({ where: { organization: { name: "acme" } } })).toBe(
      `exists (select 1 from "Organization" as "_r0" ` +
        `where "_r0"."id" = "User"."organizationId" and "_r0"."name" = ?)`,
    );
  });

  test("is and the shorthand compile identically", () => {
    expect(predicate({ where: { organization: { is: { name: "acme" } } } })).toBe(
      predicate({ where: { organization: { name: "acme" } } }),
    );
  });

  /**
   * `isNot` has to cover "the related row does not match" **and** "there is no
   * related row" — `not exists` gives both, where `exists (… and not …)` would
   * silently drop every parent with no relation.
   */
  test("isNot negates the whole existence", () => {
    expect(predicate({ where: { organization: { isNot: { name: "acme" } } } })).toBe(
      `not exists (select 1 from "Organization" as "_r0" ` +
        `where "_r0"."id" = "User"."organizationId" and "_r0"."name" = ?)`,
    );
  });

  test("null means there is no related row", () => {
    const expected =
      `not exists (select 1 from "Organization" as "_r0" ` +
      `where "_r0"."id" = "User"."organizationId")`;

    expect(predicate({ where: { organization: null } })).toBe(expected);
    expect(predicate({ where: { organization: { is: null } } })).toBe(expected);
  });

  test("isNot null means there is one", () => {
    expect(predicate({ where: { organization: { isNot: null } } })).toBe(
      `exists (select 1 from "Organization" as "_r0" ` +
        `where "_r0"."id" = "User"."organizationId")`,
    );
  });
});

describe("nesting", () => {
  /**
   * The alias is what makes this work, and it is why the child is aliased even
   * when nothing is ambiguous: the inner filter's correlation has to name the
   * *enclosing subquery's* row, not the outer table's.
   */
  test("a relation filter inside a relation filter", () => {
    expect(
      predicate({
        where: {
          accounts: { some: { organization: { name: "acme" } } },
        },
      }),
    ).toBe(
      `exists (select 1 from "Account" as "_r0" ` +
        `where "_r0"."userId" = "User"."id" and ` +
        `exists (select 1 from "Organization" as "_r1" ` +
        `where "_r1"."id" = "_r0"."organizationId" and "_r1"."name" = ?))`,
    );
  });

  test("scalars beside a relation filter still qualify to their own scope", () => {
    expect(
      predicate({
        where: { email: "a@b.c", accounts: { some: { organizationRole: "owner" } } },
      }),
    ).toBe(
      `(exists (select 1 from "Account" as "_r0" ` +
        `where "_r0"."userId" = "User"."id" and "_r0"."organizationRole" = ?) ` +
        `and "email" = ?)`,
    );
  });

  test("combinators carry relation filters", () => {
    expect(
      predicate({
        where: { OR: [{ accounts: { some: {} } }, { email: "a@b.c" }] },
      }),
    ).toBe(
      `(exists (select 1 from "Account" as "_r0" ` +
        `where "_r0"."userId" = "User"."id") or "email" = ?)`,
    );
  });

  test("NOT wraps one", () => {
    expect(predicate({ where: { NOT: { accounts: { some: {} } } } })).toBe(
      `not (exists (select 1 from "Account" as "_r0" ` +
        `where "_r0"."userId" = "User"."id"))`,
    );
  });
});

describe("values stay parameters", () => {
  test("the filter's values bind in order, and none reach the text", () => {
    const plan = compileRead(
      user,
      "findMany",
      { where: { email: "a@b.c", accounts: { some: { organizationRole: "owner" } } } },
      sqlite,
    );

    expect(plan.text).not.toContain("owner");
    expect(plan.text).not.toContain("a@b.c");
    expect(
      plan.bind({
        where: { email: "a@b.c", accounts: { some: { organizationRole: "owner" } } },
      }),
    ).toEqual(["owner", "a@b.c"]);
  });

  /** Invariant 2: same shape, different values, byte-identical SQL. */
  test("two values produce one SQL text", () => {
    expect(predicate({ where: { accounts: { some: { organizationRole: "a" } } } })).toBe(
      predicate({ where: { accounts: { some: { organizationRole: "b" } } } }),
    );
  });
});

describe("dialects", () => {
  test("postgres numbers its placeholders", () => {
    expect(
      predicate({ where: { accounts: { some: { organizationRole: "owner" } } } }, postgres),
    ).toBe(
      `exists (select 1 from "Account" as "_r0" ` +
        `where "_r0"."userId" = "User"."id" and "_r0"."organizationRole" = $1)`,
    );
  });
});

describe("what it refuses", () => {
  test("a to-many with no operator", () => {
    expect(() => text({ where: { accounts: { organizationRole: "owner" } } })).toThrow(
      UnsupportedQueryError,
    );
    expect(() => text({ where: { accounts: { organizationRole: "owner" } } })).toThrow(
      /every, none, some/,
    );
  });

  test("null on a to-many, with the operator that means it", () => {
    expect(() => text({ where: { accounts: null } })).toThrow(/none: \{\}/);
  });

  test("a scalar where a filter belongs", () => {
    expect(() => text({ where: { organization: 7 } })).toThrow(
      UnsupportedQueryError,
    );
  });

  /**
   * Refused rather than guessed at — the same call `lateralStrategy` makes for
   * this relation kind, and for the same reason: the template's schema has no
   * implicit m-n, so anything built here would ship untested against Prisma.
   */
  test("an implicit many-to-many", () => {
    const post = {
      ...user,
      name: "Post",
      table: "Post",
      relations: {
        tags: {
          name: "tags",
          model: "Tag",
          kind: "many" as const,
          relationName: "PostToTag",
          from: [],
          to: [],
          nullable: false,
          joinTable: { table: "_PostToTag", a: "Post", b: "Tag" },
        },
      },
    };

    expect(() =>
      compileRead(post, "findMany", { where: { tags: { some: {} } } }, sqlite),
    ).toThrow(/implicit many-to-many/);
  });
});
