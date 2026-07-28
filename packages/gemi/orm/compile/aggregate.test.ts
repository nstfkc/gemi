import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import { account, mapped, organization, reading, user } from "../fixtures";
import * as registry from "../registry";
import { compileAggregate } from "./aggregate";
import { compileRead } from "./read";

/**
 * `aggregate`, and the `select` form of `count`.
 *
 * The differential harness covers the shapes the template's schema can reach —
 * `Int`, `String`, `DateTime` — against Prisma on both dialects, which is the
 * stronger test and the one that owns "does it match Prisma". What it *cannot*
 * reach is the rest of the type table: the template has no `BigInt`, `Float`,
 * `Decimal`, `Json` or `Bytes` column, so the coercion rules for those are only
 * checkable here. That is the division of labour, and the `BigInt` case below is
 * the one that would otherwise be silently wrong in production.
 */

const postgres = new PostgresDialect();
const sqlite = new SqliteDialect();

beforeEach(() => {
  registry.clearRegistry();
  registry.register("User", class { static $schema = user });
  registry.register("Account", class { static $schema = account });
  registry.register("Organization", class { static $schema = organization });
});

afterEach(() => registry.clearRegistry());

const plan = (args: any, dialect = postgres, schema = user) =>
  compileAggregate(schema, "aggregate", args, dialect);

const text = (args: any, dialect = postgres, schema = user) =>
  plan(args, dialect, schema).text;

describe("what it emits", () => {
  test("one function per requested field", () => {
    expect(text({ _sum: { globalRole: true } })).toBe(
      `select sum("globalRole") as "_sum_0" from "User"`,
    );
    expect(text({ _avg: { globalRole: true } })).toContain(`avg("globalRole")`);
    expect(text({ _min: { globalRole: true } })).toContain(`min("globalRole")`);
    expect(text({ _max: { globalRole: true } })).toContain(`max("globalRole")`);
  });

  /**
   * The distinction the whole per-field form exists for: `count(*)` counts
   * rows, `count("email")` counts rows where the column is not null. Emitting
   * the first for both would be plausible and would return a different number.
   */
  test("_count counts rows, and a field counts non-nulls", () => {
    expect(text({ _count: true })).toContain(`count(*)`);
    expect(text({ _count: { _all: true } })).toContain(`count(*)`);
    expect(text({ _count: { email: true } })).toContain(`count("email")`);
  });

  test("several functions share one statement", () => {
    const emitted = text({
      _count: { _all: true },
      _sum: { globalRole: true },
      _min: { createdAt: true },
    });

    expect(emitted.match(/select /g)).toHaveLength(1);
    expect(emitted).toContain(`count(*)`);
    expect(emitted).toContain(`sum("globalRole")`);
    expect(emitted).toContain(`min("createdAt")`);
  });

  test("a where binds its values", () => {
    const args = { where: { globalRole: 2 }, _count: true };
    const compiled = plan(args);

    expect(compiled.text).toContain(`where "globalRole" = $1`);
    expect(compiled.bind(args)).toEqual([2]);
  });

  test("the column list respects @map", () => {
    expect(text({ _max: { occurredAt: true } }, postgres, mapped)).toContain(
      `max("occurred_at")`,
    );
  });

  /**
   * Aliases are positional rather than named after the field. A model could
   * carry a field called `_all`, and `"_count_" + fieldName` would then collide
   * with `_count`'s own alias — two aggregates arriving under one key, with the
   * second silently winning.
   */
  test("two aggregates over the same field get distinct aliases", () => {
    const emitted = text({
      _min: { globalRole: true },
      _max: { globalRole: true },
    });

    const aliases = [...emitted.matchAll(/as "(_\w+_\d+)"/g)].map((m) => m[1]);
    expect(aliases).toHaveLength(2);
    expect(new Set(aliases).size).toBe(2);
  });
});

/**
 * `take` / `skip` describe the rows being aggregated, not the one row the
 * aggregate produces. A `limit` beside the aggregate would cap the *result*,
 * which is always one row, and quietly report the unpaginated total.
 */
describe("pagination", () => {
  test("a paginated aggregate wraps its rows in a subquery", () => {
    const args = { orderBy: { globalRole: "asc" }, take: 2, _sum: { globalRole: true } };
    const compiled = plan(args);

    expect(compiled.text).toBe(
      `select sum("globalRole") as "_sum_0" from (select "globalRole" from ` +
        `"User" order by "globalRole" asc limit $1) as "sub"`,
    );
    expect(compiled.bind(args)).toEqual([2]);
  });

  test("the subquery selects every column an aggregate names", () => {
    const emitted = text({
      take: 1,
      _sum: { globalRole: true },
      _max: { createdAt: true },
    });

    expect(emitted).toContain(`select "globalRole", "createdAt" from "User"`);
  });

  /**
   * With only `count(*)` there is no column to carry, so it selects the primary
   * key — the narrowest thing that keeps a row identity, and what the paginated
   * `count` does for the same reason.
   */
  test("a paginated count(*) selects the primary key", () => {
    expect(text({ take: 2, _count: true })).toContain(`select "id" from "User"`);
  });

  test("paginating without an orderBy orders by the primary key", () => {
    expect(text({ take: 2, _count: true })).toContain(`order by "id" asc`);
  });

  test("an unpaginated aggregate has no subquery at all", () => {
    expect(text({ _count: true })).toBe(`select count(*) as "_count_0" from "User"`);
  });

  test("a negative take flips the order and binds its magnitude", () => {
    const args = { orderBy: { globalRole: "asc" }, take: -2, _sum: { globalRole: true } };
    const compiled = plan(args);

    expect(compiled.text).toContain(`order by "globalRole" desc`);
    expect(compiled.bind(args)).toEqual([2]);
  });

  /**
   * #84 reaches here because `aggregate` pages, and it validates its arguments
   * in a different file from `read.ts`. The check lives in `paginate.ts` — the
   * one place that *reads* these two — rather than in each caller's allowlist,
   * so this passes without `aggregate.ts` knowing the rule exists.
   */
  test("a take that is not an integer is refused here too", () => {
    expect(() => plan({ take: "-2", _count: true })).toThrow(
      /Expected an integer, got "-2"/,
    );
    expect(() => plan({ skip: -1, _count: true })).toThrow(
      /'skip' counts rows to pass over/,
    );
    expect(() => plan({ take: "-2", _count: true })).toThrow(/User\.aggregate/);
  });
});

/**
 * The coercion table, which is where this operation earns or loses its
 * correctness: `sum(integer)` is `bigint` in Postgres and `avg(integer)` is
 * `numeric`, and Bun hands both back as strings.
 */
describe("turning the driver's values into Prisma's", () => {
  const shape = (args: any, row: Record<string, unknown>, schema = user) =>
    plan(args, postgres, schema).shape([row]) as any;

  test("_count is a number, even though the driver says string", () => {
    expect(shape({ _count: true }, { _count_0: "3" })._count).toBe(3);
    expect(shape({ _count: { _all: true } }, { _count_0: "3" })._count).toEqual({
      _all: 3,
    });
  });

  test("_avg is a number, even for an integer column", () => {
    expect(
      shape({ _avg: { globalRole: true } }, { _avg_0: "2.0000000000000000" }),
    ).toEqual({ _avg: { globalRole: 2 } });
  });

  test("_sum over an Int column is a number", () => {
    expect(shape({ _sum: { globalRole: true } }, { _sum_0: "15" })).toEqual({
      _sum: { globalRole: 15 },
    });
  });

  /**
   * The one that would be silently wrong. `sum(bigint)` crosses as an exact
   * string, and `Number()` on 9007199254740995 drops the low bits — in a value
   * whose entire reason for being a `BigInt` is that it does not fit a double.
   * Same trap the lateral strategy's `::text` cast exists for.
   */
  test("_sum over a BigInt column keeps every bit", () => {
    const result = shape({ _sum: { size: true } }, { _sum_0: "9007199254740995" }, mapped);

    expect(result._sum.size).toBe(9007199254740995n);
    // Compared as text, because the loss this guards against is invisible to a
    // numeric comparison: the *literal* 9007199254740995 is already
    // 9007199254740996 by the time it reaches the assertion, so `not.toBe` a
    // number would pass for the broken implementation too.
    expect(String(result._sum.size)).toBe("9007199254740995");
    expect(String(Number("9007199254740995"))).toBe("9007199254740996");
  });

  test("_sum over a Float column is a number", () => {
    expect(shape({ _sum: { value: true } }, { _sum_0: 4.5 }, reading)).toEqual({
      _sum: { value: 4.5 },
    });
  });

  test("_min and _max decode as values of their column", () => {
    // Postgres hands a `bigint` back as text; the column's own decoder is what
    // knows to make it a BigInt rather than a number.
    expect(
      shape({ _max: { size: true } }, { _max_0: "9007199254740993" }, mapped)._max,
    ).toEqual({ size: 9007199254740993n });

    // ...and on SQLite a DateTime is integer milliseconds.
    const dates = compileAggregate(user, "aggregate", { _min: { createdAt: true } }, sqlite)
      .shape([{ _min_0: 1600000000000 }]) as any;
    expect(dates._min.createdAt).toBeInstanceOf(Date);
    expect(dates._min.createdAt.toISOString()).toBe("2020-09-13T12:26:40.000Z");
  });

  /**
   * `_count` over no rows is `0`; every other function is `null`, per field.
   * Coalescing them all to `0` would look right in every test that has rows.
   */
  test("an empty set is zero for counts and null for everything else", () => {
    const result = shape(
      {
        _count: { _all: true, email: true },
        _sum: { globalRole: true },
        _avg: { globalRole: true },
        _min: { globalRole: true },
        _max: { createdAt: true },
      },
      { _count_0: "0", _count_1: "0", _sum_2: null, _avg_3: null, _min_4: null, _max_5: null },
    );

    expect(result).toEqual({
      _count: { _all: 0, email: 0 },
      _sum: { globalRole: null },
      _avg: { globalRole: null },
      _min: { globalRole: null },
      _max: { createdAt: null },
    });
  });

  test("a bare _count is a number rather than an object", () => {
    expect(shape({ _count: true }, { _count_0: "7" })).toEqual({ _count: 7 });
  });
});

describe("what it refuses", () => {
  test("an aggregate with no functions", () => {
    expect(() => plan({})).toThrow(/at least one of/);
    expect(() => plan(undefined)).toThrow(/at least one of/);
    expect(() => plan({ where: { globalRole: 1 } })).toThrow(/at least one of/);
  });

  test("an unknown field", () => {
    expect(() => plan({ _sum: { nope: true } })).toThrow(UnknownFieldError);
  });

  /**
   * A relation named here is a plausible mistake — `_count: { accounts: true }`
   * reads like counting the relation — and the default "unknown field" message
   * would send the caller looking for a typo.
   */
  test("a relation, with a message that says what to do instead", () => {
    expect(() => plan({ _count: { accounts: true } })).toThrow(
      /'accounts' is a relation/,
    );
    expect(() => plan({ _count: { accounts: true } })).toThrow(/_count' inside an 'include'/);
  });

  test.each([
    ["_sum", "email"],
    ["_avg", "email"],
    ["_sum", "createdAt"],
  ])("%s over a non-numeric column (%s)", (kind, field) => {
    expect(() => plan({ [kind]: { [field]: true } })).toThrow(
      /needs a number/,
    );
  });

  test.each([
    ["_min", "payload"],
    ["_max", "payload"],
  ])("%s over a Json column (%s)", (kind, field) => {
    expect(() => plan({ [kind]: { [field]: true } }, postgres, mapped)).toThrow(
      /no ordering the two/,
    );
  });

  test("_min over a Bytes column", () => {
    expect(() => plan({ _min: { digest: true } }, postgres, reading)).toThrow(
      /no ordering the two/,
    );
  });

  test("select and include, which an aggregate has no use for", () => {
    expect(() => plan({ _count: true, select: { id: true } })).toThrow(
      /nothing to select/,
    );
    expect(() => plan({ _count: true, include: { accounts: true } })).toThrow(
      /nothing to include/,
    );
  });

  test("an unknown argument", () => {
    expect(() => plan({ _count: true, cursor: { id: 1 } })).toThrow(
      UnsupportedQueryError,
    );
  });

  test("a malformed function value", () => {
    expect(() => plan({ _sum: true })).toThrow(/Expected an object of fields/);
    expect(() => plan({ _count: 3 })).toThrow(/Expected true or an object/);
  });

  test("an orderBy is validated whether or not it paginates", () => {
    expect(() => plan({ _count: true, orderBy: { nope: "asc" } })).toThrow(
      UnknownFieldError,
    );
    expect(() =>
      plan({ _count: true, orderBy: { nope: "asc" }, take: 1 }),
    ).toThrow(UnknownFieldError);
  });
});

/**
 * `count({ select })` is the same statement with a flatter result: no `_count`
 * wrapper, because the operation already says what the numbers are. It routes
 * through this compiler rather than reimplementing the per-field rule.
 */
describe("count with a select", () => {
  const counted = (args: any) => compileRead(user, "count", args, postgres);

  test("returns a flat object of counts", () => {
    const compiled = counted({ select: { _all: true, email: true } });

    expect(compiled.text).toContain(`count(*)`);
    expect(compiled.text).toContain(`count("email")`);
    expect(compiled.shape([{ _count_0: "5", _count_1: "3" }])).toEqual({
      _all: 5,
      email: 3,
    });
  });

  test("a count with no select is still a plain number", () => {
    const compiled = counted({});
    expect(compiled.shape([{ _count: 4 }])).toBe(4);
  });

  test("a select naming nothing is refused", () => {
    expect(() => counted({ select: {} })).toThrow(/at least one field/);
    expect(() => counted({ select: { email: false } })).toThrow(/at least one field/);
  });

  test("a where and pagination still apply", () => {
    const args = { where: { globalRole: 2 }, take: 2, select: { _all: true } };
    const compiled = counted(args);

    expect(compiled.text).toContain(`) as "sub"`);
    expect(compiled.bind(args)).toEqual([2, 2]);
  });
});
