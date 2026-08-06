import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import { account, organization, user } from "../fixtures";
import * as registry from "../registry";
import { compileGroupBy } from "./group-by";

/**
 * `groupBy` — the half of #64 that `aggregate` did not cover.
 *
 * The differential harness owns "does it match Prisma" for the shapes the
 * template's schema can reach. What lives here is the SQL and the refusals: the
 * `having` compiler, the `orderBy` restriction, and the argument validation,
 * none of which a result comparison can see the reasoning of.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

beforeEach(() => {
  registry.clearRegistry();
  registry.register("User", class { static $schema = user });
  registry.register("Account", class { static $schema = account });
  registry.register("Organization", class { static $schema = organization });
});

afterEach(() => registry.clearRegistry());

const plan = (args: any, dialect = sqlite) =>
  compileGroupBy(user, "groupBy", args, dialect);
const text = (args: any, dialect = sqlite) => plan(args, dialect).text;

describe("what it emits", () => {
  test("the grouped column is projected and grouped by", () => {
    expect(text({ by: ["globalRole"], _count: true })).toBe(
      `select "globalRole" as "_by_0", count(*) as "_count_0" from "User" ` +
        `group by "globalRole"`,
    );
  });

  // Prisma accepts both, and the string form is what a caller reaches for with
  // one field. Measured against a live client rather than read off the types,
  // which look array-only.
  test("by takes a bare string as well as an array", () => {
    expect(text({ by: "globalRole", _count: true })).toBe(
      text({ by: ["globalRole"], _count: true }),
    );
  });

  test("several grouped columns keep their order", () => {
    expect(text({ by: ["globalRole", "locale"], _count: true })).toContain(
      `group by "globalRole", "locale"`,
    );
  });

  test("every aggregate kind compiles to its function", () => {
    const emitted = text({
      by: ["globalRole"],
      _count: { _all: true },
      _sum: { globalRole: true },
      _avg: { globalRole: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });

    expect(emitted).toContain(`count(*)`);
    expect(emitted).toContain(`sum("globalRole")`);
    expect(emitted).toContain(`avg("globalRole")`);
    expect(emitted).toContain(`min("createdAt")`);
    expect(emitted).toContain(`max("createdAt")`);
  });

  /**
   * Unlike `aggregate`, which wraps its rows in a subquery so the `limit` does
   * not cap the single result row, a `limit` after `group by` already means
   * "this many groups" — which is what Prisma means too.
   */
  test("take and skip page the groups, with no subquery", () => {
    const args = { by: ["globalRole"], _count: true, take: 2, skip: 1 };
    const emitted = text(args);

    expect(emitted.match(/select /g)).toHaveLength(1);
    expect(emitted).toContain(`group by "globalRole" limit ? offset ?`);
    expect(plan(args).bind(args)).toEqual([2, 1]);
  });

  /**
   * The claim #88 made, checked from the other side.
   *
   * It moved `take` / `skip` validation into `pagination` rather than into each
   * caller's argument allowlist, arguing a fourth pager should not be able to
   * arrive without it. `groupBy` is that fourth pager, written against a base
   * where #88 had not merged — and it acquired the check on the merge, with no
   * line here doing anything about it.
   */
  test("take and skip are validated, without this file knowing the rule", () => {
    expect(() => text({ by: ["globalRole"], _count: true, take: "-2" })).toThrow(
      /Expected an integer, got "-2"/,
    );
    expect(() => text({ by: ["globalRole"], _count: true, skip: -1 })).toThrow(
      /'skip' counts rows to pass over/,
    );
    // ...and the refusal names this operation, not the one the check lives in.
    expect(() => text({ by: ["globalRole"], _count: true, take: 1.5 })).toThrow(
      /User\.groupBy/,
    );
  });

  test("a where filters rows before grouping, and binds", () => {
    const args = { by: ["globalRole"], _count: true, where: { locale: "fr-FR" } };
    expect(text(args)).toContain(`where "locale" = ? group by`);
    expect(plan(args).bind(args)).toEqual(["fr-FR"]);
  });

  test("postgres numbers the placeholders", () => {
    const args = { by: ["globalRole"], _count: true, where: { locale: "x" }, take: 1 };
    expect(text(args, postgres)).toContain(`where "locale" = $1`);
    expect(text(args, postgres)).toContain(`limit $2`);
  });
});

describe("having", () => {
  test("an aggregate filter compiles to a function, not a column", () => {
    const args = { by: ["globalRole"], _count: true, having: { globalRole: { _count: { gt: 1 } } } };
    expect(text(args)).toContain(`having count("globalRole") > ?`);
    expect(plan(args).bind(args)).toEqual([1]);
  });

  test("a plain filter on a grouped column compiles to the column", () => {
    const args = { by: ["globalRole"], _count: true, having: { globalRole: { gt: 0 } } };
    expect(text(args)).toContain(`having "globalRole" > ?`);
    expect(plan(args).bind(args)).toEqual([0]);
  });

  test("a bare value is equals, the shorthand where accepts", () => {
    const args = { by: ["globalRole"], _count: true, having: { globalRole: 2 } };
    expect(text(args)).toContain(`having "globalRole" = ?`);
    expect(plan(args).bind(args)).toEqual([2]);
  });

  test("AND, OR and NOT nest", () => {
    const args = {
      by: ["globalRole"],
      _count: true,
      having: {
        OR: [{ globalRole: { equals: 0 } }, { globalRole: { _count: { gt: 1 } } }],
      },
    };
    expect(text(args)).toContain(
      `having ("globalRole" = ? or count("globalRole") > ?)`,
    );
    expect(plan(args).bind(args)).toEqual([0, 1]);
  });

  test("null is IS NULL rather than a bound comparison", () => {
    const args = { by: ["name"], _count: true, having: { name: { equals: null } } };
    expect(text(args)).toContain(`having "name" is null`);
    expect(plan(args).bind(args)).toEqual([]);
  });

  /**
   * Prisma: *"Every field used in `having` filters must either be an
   * aggregation filter or be included in the selection of the query"*. SQL
   * would reject the bare-column form too, but with a message naming neither
   * the argument nor the model — and the *aggregate* form is legal SQL, so
   * without this it would silently be allowed where Prisma refuses.
   */
  test("a plain filter on an ungrouped column is refused", () => {
    expect(() =>
      text({ by: ["globalRole"], _count: true, having: { locale: { equals: "x" } } }),
    ).toThrow(/is not in 'by'/);
  });

  /**
   * The other half of the same sentence, and the half that is easy to get
   * wrong: an *aggregate* over an ungrouped column is accepted, because
   * `count(locale)` has one value per group whether or not `locale` is grouped.
   * Measured against a live Prisma client rather than inferred from the refusal
   * above — reading that message as "the field must be in `by`" would refuse a
   * query Prisma answers.
   */
  test("an aggregate filter on an ungrouped column is allowed", () => {
    expect(
      text({ by: ["globalRole"], _count: true, having: { locale: { _count: { gt: 1 } } } }),
    ).toContain(`having count("locale") > ?`);
  });

  /**
   * Prisma's query engine panics on this shape — `internal error: entered
   * unreachable code` — so there is no behaviour to match and nothing to
   * differentially test against. Refused by name, with the spelling that works.
   */
  test("mixing a plain and an aggregate filter on one key is refused", () => {
    expect(() =>
      text({
        by: ["globalRole"],
        _count: true,
        having: { globalRole: { gt: 0, _count: { gt: 1 } } },
      }),
    ).toThrow(/not both/);
  });

  test("an unknown operator names itself", () => {
    expect(() =>
      text({ by: ["globalRole"], _count: true, having: { globalRole: { contains: 1 } } }),
    ).toThrow(/having.globalRole.contains/);
  });

  test("no value reaches the SQL text", () => {
    const args = {
      by: ["globalRole"],
      _count: true,
      having: {
        AND: [{ globalRole: { gt: 7 } }, { globalRole: { _count: { lte: 9 } } }],
      },
    };
    expect(text(args)).not.toContain("7");
    expect(text(args)).not.toContain("9");
    expect(plan(args).bind(args)).toEqual([7, 9]);
  });
});

describe("orderBy", () => {
  test("a grouped column orders by that column", () => {
    expect(text({ by: ["globalRole"], _count: true, orderBy: { globalRole: "desc" } })).toContain(
      `order by "globalRole" desc`,
    );
  });

  test("an aggregate orders by the function", () => {
    expect(
      text({ by: ["globalRole"], _count: true, orderBy: { _count: { globalRole: "desc" } } }),
    ).toContain(`order by count("globalRole") desc`);
  });

  test("_count._all orders by count(*)", () => {
    expect(
      text({ by: ["globalRole"], _count: true, orderBy: { _count: { _all: "asc" } } }),
    ).toContain(`order by count(*) asc`);
  });

  /**
   * **The long form, which `groupBy` had to be taught separately** — #337.
   *
   * This is the one `orderBy` that does not go through `parseOrderBy`: it has
   * its own reader, because a grouped ordering may name an aggregate rather
   * than a column. So `{ sort, nulls }` was a runtime refusal here long after
   * `findMany` accepted it, and widening `OrderByInput` without this would have
   * left a type that accepts what the compiler throws on — in the operation
   * where the placement matters most, since a grouped column is exactly the
   * kind that is often null.
   */
  test("a grouped column takes the long form", () => {
    expect(
      text({
        by: ["globalRole"],
        _count: true,
        orderBy: { globalRole: { sort: "asc", nulls: "last" } },
      }),
    ).toContain(`order by "globalRole" asc nulls last`);
  });

  test("and so does an aggregate ordering", () => {
    expect(
      text({
        by: ["globalRole"],
        _count: true,
        orderBy: { _count: { globalRole: { sort: "desc", nulls: "first" } } },
      }),
    ).toContain(`order by count("globalRole") desc nulls first`);
  });

  test("the short form is unchanged, and `nulls` stays optional", () => {
    expect(
      text({
        by: ["globalRole"],
        _count: true,
        orderBy: { globalRole: { sort: "desc" } },
      }),
    ).toContain(`order by "globalRole" desc`);
  });

  test.each([
    ["a nulls that is neither", { sort: "asc", nulls: "sideways" }],
    ["a sort that is not a direction", { sort: "up" }],
    ["an array", ["asc"]],
  ])("%s is refused", (_label, value) => {
    expect(() =>
      text({ by: ["globalRole"], _count: true, orderBy: { globalRole: value } }),
    ).toThrow(UnsupportedQueryError);
  });

  /**
   * Prisma: *"Every field used for orderBy must be included in the
   * by-arguments of the query"*. A group has one value for a grouped column and
   * many for everything else, so ordering by an ungrouped one is a question
   * with no answer — and SQLite answers it anyway, by picking an arbitrary
   * row's value. A silently arbitrary order is worse than a refusal.
   */
  test("an ungrouped column is refused rather than silently arbitrary", () => {
    expect(() =>
      text({ by: ["globalRole"], _count: true, orderBy: { email: "asc" } }),
    ).toThrow(/is not in 'by'/);
  });

  test("ordering by a subset of the grouped columns is fine", () => {
    expect(
      text({ by: ["globalRole", "locale"], _count: true, orderBy: { locale: "asc" } }),
    ).toContain(`order by "locale" asc`);
  });

  /**
   * #64 predicted Prisma would require an `orderBy` whenever `by` is given.
   * Measured against a live client, it does not — so requiring one here would
   * have refused a legal query.
   */
  test("it is optional", () => {
    expect(text({ by: ["globalRole"], _count: true })).not.toContain("order by");
  });

  test("a direction outside the closed set is refused", () => {
    expect(() =>
      text({ by: ["globalRole"], _count: true, orderBy: { globalRole: "sideways" } }),
    ).toThrow(UnsupportedQueryError);
    expect(() =>
      text({ by: ["globalRole"], _count: true, orderBy: { globalRole: "asc; drop table User" } }),
    ).toThrow(UnsupportedQueryError);
  });

  test("an unknown column is an unknown field, not a group error", () => {
    expect(() =>
      text({ by: ["globalRole"], _count: true, orderBy: { nope: "asc" } }),
    ).toThrow(UnknownFieldError);
  });
});

describe("arguments", () => {
  test("by is required", () => {
    expect(() => text({ _count: true })).toThrow(/requires 'by'/);
    expect(() => text(undefined)).toThrow(/requires 'by'/);
  });

  test("an empty by is refused, naming the operation that would fit", () => {
    expect(() => text({ by: [], _count: true })).toThrow(/nothing to group/);
  });

  test("an unknown grouped field is an unknown field", () => {
    expect(() => text({ by: ["nope"], _count: true })).toThrow(UnknownFieldError);
  });

  test("a relation cannot be grouped by", () => {
    expect(() => text({ by: ["accounts"], _count: true })).toThrow(/is a relation/);
  });

  test("an unsupported argument names itself", () => {
    expect(() => text({ by: ["globalRole"], include: { accounts: true } })).toThrow(
      /include/,
    );
  });

  /** A duplicate would return the column twice under one key. */
  test("a repeated grouped field is grouped once", () => {
    expect(text({ by: ["globalRole", "globalRole"], _count: true })).toBe(
      text({ by: ["globalRole"], _count: true }),
    );
  });

  /** Legal in Prisma: the groups themselves, with nothing aggregated. */
  test("no aggregate at all is legal", () => {
    expect(text({ by: ["globalRole"] })).toBe(
      `select "globalRole" as "_by_0" from "User" group by "globalRole"`,
    );
  });
});

describe("shaping", () => {
  test("grouped columns are flat and aggregates are nested", () => {
    const compiled = plan({
      by: ["globalRole"],
      _count: true,
      _sum: { globalRole: true },
    });

    expect(compiled.shape([{ _by_0: 1, _count_0: 3, _sum_1: 9 }])).toEqual([
      { globalRole: 1, _count: 3, _sum: { globalRole: 9 } },
    ]);
  });

  test("_count over fields is an object, like aggregate's", () => {
    const compiled = plan({ by: ["globalRole"], _count: { _all: true, email: true } });
    expect(compiled.shape([{ _by_0: 0, _count_0: 3, _count_1: 2 }])).toEqual([
      { globalRole: 0, _count: { _all: 3, email: 2 } },
    ]);
  });

  test("many groups come back as many objects", () => {
    const compiled = plan({ by: ["globalRole"], _count: true });
    expect(
      compiled.shape([
        { _by_0: 0, _count_0: 3 },
        { _by_0: 1, _count_0: 1 },
      ]),
    ).toEqual([
      { globalRole: 0, _count: 3 },
      { globalRole: 1, _count: 1 },
    ]);
  });

  /**
   * The grouped column is a *value of the column*, so the dialect's own decode
   * applies — which is what turns SQLite's integer milliseconds back into a
   * `Date`. Grouping by a `DateTime` is unusual and getting it wrong would be
   * silent: a number where Prisma returns a date.
   */
  test("a grouped column is decoded by the dialect", () => {
    const compiled = plan({ by: ["createdAt"], _count: true });
    const [row] = compiled.shape([{ _by_0: 1600000000000, _count_0: 1 }]) as any[];
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.createdAt.toISOString()).toBe("2020-09-13T12:26:40.000Z");
  });

  test("no groups is an empty array, not null", () => {
    expect(plan({ by: ["globalRole"], _count: true }).shape([])).toEqual([]);
  });

  /**
   * An argument `groupBy` does not take, refused **with the set it does**.
   *
   * This one call site was left with three arguments when #102 made `detail`
   * required, so `feat/orm` stopped typechecking the moment that merged
   * alongside `groupBy`. Neither PR could see it: #92 added the call, #102
   * changed the signature, and each typechecked on its own branch.
   *
   * `tsc` is what catches the signature; this is what catches the *message*,
   * which is the thing #61's second half was actually about — an argument the
   * operation does not accept is the path a typo takes, and naming the set is
   * the whole of the answer.
   */
  test("an unknown argument names the ones groupBy takes", () => {
    let message = "";
    try {
      plan({ by: ["globalRole"], _count: true, nope: 1 } as never);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("'nope'");
    // The set, sorted, exactly as `read.ts` words the same refusal.
    expect(message).toMatch(/groupBy takes .*\bby\b.*/);
    expect(message).toContain("having");
    expect(message).toContain("orderBy");
  });
});
