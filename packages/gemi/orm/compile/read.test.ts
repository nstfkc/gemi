import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import {
  InvalidArgumentError,
  ParameterLimitError,
  UnknownFieldError,
  UnsupportedByDesignError,
  UnsupportedQueryError,
} from "../errors";
import { USER_COLUMNS, account, mapped, user } from "../fixtures";
import { compile } from "./index";
import { compileRead } from "./read";
import { compileWrite } from "./write";
import { compileWhere } from "./where";
import * as registry from "../registry";
import type { RelationStrategy } from "./plan-relations";
import { render, sql } from "./fragment";


const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

const SELECT_USER = `select ${USER_COLUMNS} from "User"`;

function text(args: any, op: any = "findMany", dialect = sqlite) {
  return compileRead(user, op, args, dialect).text;
}

function bind(args: any, op: any = "findMany", dialect = sqlite) {
  return compileRead(user, op, args, dialect).bind(args);
}

// The whole point of splitting compile from bind is that these tests need no
// database at all: `compile` is a pure function of the argument *shape*.
describe("scalar operators — sqlite", () => {
  test("equality, shorthand and explicit", () => {
    expect(text({ where: { email: "a@b.c" } })).toBe(
      `${SELECT_USER} where "email" = ?`,
    );
    expect(text({ where: { email: { equals: "a@b.c" } } })).toBe(
      `${SELECT_USER} where "email" = ?`,
    );
  });

  // `= ?` with a null parameter matches nothing in SQL, where Prisma means
  // `is null`. This is the divergence that returns silently wrong rows.
  test("null is IS NULL, and takes no parameter", () => {
    const args = { where: { deletedAt: null } };
    expect(text(args)).toBe(`${SELECT_USER} where "deletedAt" is null`);
    expect(bind(args)).toEqual([]);

    expect(text({ where: { deletedAt: { equals: null } } })).toBe(
      `${SELECT_USER} where "deletedAt" is null`,
    );
  });

  test("not: null is IS NOT NULL", () => {
    expect(text({ where: { deletedAt: { not: null } } })).toBe(
      `${SELECT_USER} where "deletedAt" is not null`,
    );
  });

  test("not: value is <>", () => {
    const args = { where: { email: { not: "x" } } };
    expect(text(args)).toBe(`${SELECT_USER} where "email" <> ?`);
    expect(bind(args)).toEqual(["x"]);
  });

  test.each([
    ["lt", "<"],
    ["lte", "<="],
    ["gt", ">"],
    ["gte", ">="],
  ])("%s compiles to %s", (operator, symbol) => {
    const args = { where: { id: { [operator]: 5 } } };
    expect(text(args)).toBe(`${SELECT_USER} where "id" ${symbol} ?`);
    expect(bind(args)).toEqual([5]);
  });

  test("several operators on one field are ANDed", () => {
    const args = { where: { id: { gt: 1, lte: 9 } } };
    expect(text(args)).toBe(`${SELECT_USER} where ("id" > ? and "id" <= ?)`);
    expect(bind(args)).toEqual([1, 9]);
  });

  // One placeholder per element on SQLite, so the length is part of the text.
  test("in expands one placeholder per element", () => {
    const args = { where: { id: { in: [1, 2, 3] } } };
    expect(text(args)).toBe(`${SELECT_USER} where "id" in (?, ?, ?)`);
    expect(bind(args)).toEqual([1, 2, 3]);
  });

  test("notIn", () => {
    const args = { where: { id: { notIn: [1, 2] } } };
    expect(text(args)).toBe(`${SELECT_USER} where "id" not in (?, ?)`);
    expect(bind(args)).toEqual([1, 2]);
  });

  // `x in ()` is a syntax error; Prisma emits a constant-false predicate.
  test("an empty in matches nothing, and an empty notIn matches everything", () => {
    expect(text({ where: { id: { in: [] } } })).toBe(
      `${SELECT_USER} where false`,
    );
    expect(text({ where: { id: { notIn: [] } } })).toBe(
      `${SELECT_USER} where true`,
    );
  });

  // Prisma does *not* escape % or _ inside the value — verified by reading the
  // parameters it binds. Matching that is the contract; escaping would diverge.
  test.each([
    ["contains", "%x%"],
    ["startsWith", "x%"],
    ["endsWith", "%x"],
  ])("%s wraps the value in the binder, not the text", (operator, pattern) => {
    const args = { where: { email: { [operator]: "x" } } };
    expect(text(args)).toBe(`${SELECT_USER} where "email" like ?`);
    expect(bind(args)).toEqual([pattern]);
  });

  test("a wildcard inside the value is passed through, as Prisma does", () => {
    expect(bind({ where: { email: { contains: "50%_x" } } })).toEqual([
      "%50%_x%",
    ]);
  });

  test("not wraps a nested filter", () => {
    const args = { where: { id: { not: { in: [1, 2] } } } };
    expect(text(args)).toBe(`${SELECT_USER} where not ("id" in (?, ?))`);
    expect(bind(args)).toEqual([1, 2]);
  });
});

describe("logical combinators", () => {
  test("AND, OR and NOT nest", () => {
    const args = {
      where: {
        AND: [
          { id: { gt: 0 } },
          { OR: [{ name: "a" }, { NOT: { email: null } }] },
        ],
      },
    };
    expect(text(args)).toBe(
      `${SELECT_USER} where ("id" > ? and ("name" = ? or not ("email" is null)))`,
    );
    expect(bind(args)).toEqual([0, "a"]);
  });

  test("AND accepts Prisma's single-object form", () => {
    expect(text({ where: { AND: { id: 1, name: "a" } } })).toBe(
      `${SELECT_USER} where ("id" = ? and "name" = ?)`,
    );
  });

  test("NOT over several keys negates the conjunction", () => {
    expect(text({ where: { NOT: { id: 1, name: "a" } } })).toBe(
      `${SELECT_USER} where not ("id" = ? and "name" = ?)`,
    );
  });

  // Verified against Prisma: an empty AND is vacuously true, an empty OR is
  // false. Getting these backwards silently changes which rows come back.
  test("an empty AND is true and an empty OR is false", () => {
    expect(text({ where: { AND: [] } })).toBe(SELECT_USER);
    expect(text({ where: { OR: [] } })).toBe(`${SELECT_USER} where false`);
  });

  test("top-level keys are ANDed in sorted order", () => {
    const args = { where: { id: 1, email: "a" } };
    expect(text(args)).toBe(`${SELECT_USER} where ("email" = ? and "id" = ?)`);
    expect(bind(args)).toEqual(["a", 1]);
  });
});

describe("orderBy", () => {
  test("object, array and long forms", () => {
    expect(text({ orderBy: { createdAt: "desc" } })).toBe(
      `${SELECT_USER} order by "createdAt" desc`,
    );
    expect(text({ orderBy: [{ name: "asc" }, { id: "desc" }] })).toBe(
      `${SELECT_USER} order by "name" asc, "id" desc`,
    );
    expect(text({ orderBy: { name: { sort: "asc", nulls: "last" } } })).toBe(
      `${SELECT_USER} order by "name" asc nulls last`,
    );
  });

  // Neither a column nor a direction is ever a parameter — both are structural.
  test("contributes no parameters", () => {
    expect(bind({ orderBy: { createdAt: "desc" } })).toEqual([]);
  });

  test("rejects a direction outside the closed set", () => {
    expect(() => text({ orderBy: { id: "sideways" } })).toThrow(
      UnsupportedQueryError,
    );
    expect(() => text({ orderBy: { id: "asc; drop table User" } })).toThrow(
      UnsupportedQueryError,
    );
  });

  test("rejects an unknown column", () => {
    expect(() => text({ orderBy: { nope: "asc" } })).toThrow(UnknownFieldError);
  });
});

describe("skip and take", () => {
  // The single most tempting place in the compiler to inline a number.
  test("are parameters, never literals", () => {
    const args = { take: 5, skip: 2 };
    expect(text(args)).toBe(`${SELECT_USER} order by "id" asc limit ? offset ?`);
    expect(bind(args)).toEqual([5, 2]);
  });

  // Verified against Prisma: paginating without an explicit order injects one
  // on the primary key, because "page 2" is otherwise not well defined.
  test("paginating without orderBy orders by the primary key", () => {
    expect(text({ take: 3 })).toBe(`${SELECT_USER} order by "id" asc limit ?`);
    expect(text({ take: 3, orderBy: { name: "asc" } })).toBe(
      `${SELECT_USER} order by "name" asc limit ?`,
    );
  });

  // SQLite cannot parse `offset` without a `limit`, so one is supplied — as a
  // parameter bound to -1, SQLite's "no limit", rather than inlined.
  test("skip alone still binds a limit on sqlite", () => {
    const args = { skip: 4 };
    expect(text(args)).toBe(`${SELECT_USER} order by "id" asc limit ? offset ?`);
    expect(bind(args)).toEqual([-1, 4]);
  });

  // Prisma reads a negative take as "the last N": it flips the ordering and
  // takes the absolute value.
  test("a negative take reverses the order and binds its magnitude", () => {
    const args = { take: -3 };
    expect(text(args)).toBe(`${SELECT_USER} order by "id" desc limit ?`);
    expect(bind(args)).toEqual([3]);

    expect(text({ take: -3, orderBy: { name: "asc" } })).toBe(
      `${SELECT_USER} order by "name" desc limit ?`,
    );
  });

  // ...and then hands the page back in the order the caller asked for. Flipping
  // the SQL is only half of it, and asserting the SQL text alone is exactly how
  // the missing half shipped.
  test("a negative take flips the result set back", () => {
    const plan = compileRead(user, "findMany", { take: -3 }, sqlite);
    const rows = plan.shape([{ id: 5 }, { id: 4 }, { id: 3 }]) as any[];
    expect(rows.map((row) => row.id)).toEqual([3, 4, 5]);
  });

  test("a positive take leaves the order alone", () => {
    const plan = compileRead(user, "findMany", { take: 3 }, sqlite);
    const rows = plan.shape([{ id: 1 }, { id: 2 }, { id: 3 }]) as any[];
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  /**
   * #84. These two arguments are the only ones whose *sign* decides the SQL, so
   * a wrong type here does not fail — it takes the other branch.
   *
   * `take: "-2"` asks for the last two rows. `typeof take === "number"` is
   * false for a string, so the order is not flipped; `Math.abs(Number(...))`
   * then binds `2`. The statement is valid, the page is the right size, and the
   * rows are the first two in the opposite order. Nothing raises.
   *
   * A query string is exactly where a string `take` comes from — `?take=-2` —
   * and the ORM's own types say `number`, so nothing in between has a reason to
   * coerce it.
   */
  test("a string take is refused, rather than silently paging the wrong end", () => {
    expect(() => text({ take: "-2" })).toThrow(UnsupportedQueryError);
    expect(() => text({ take: "-2" })).toThrow(/Expected an integer, got "-2"/);

    // The shape of the bug, pinned so a future coercion cannot reintroduce it
    // quietly: with a real -2 the order flips, which is what "-2" did not do.
    expect(text({ take: -2 })).toBe(`${SELECT_USER} order by "id" desc limit ?`);
    expect(text({ take: 2 })).toBe(`${SELECT_USER} order by "id" asc limit ?`);
  });

  /**
   * The one place this is deliberately *stricter* than Prisma, which accepts a
   * fraction and truncates toward zero. Binding it does not, and the three
   * behaviours are the argument for refusing rather than picking one:
   *
   *     prisma           take: 1.5  ->  1 row   truncates
   *     sqlite   limit ? = 1.5      ->  SQLiteError: datatype mismatch
   *     postgres limit $1 = 1.5     ->  2 rows  rounds to nearest
   *
   * Measured through Bun against both engines rather than reasoned about.
   */
  test("a fractional take is refused, which Prisma would have truncated", () => {
    expect(() => text({ take: 1.5 })).toThrow(/Expected an integer, got 1.5/);
    expect(() => text({ skip: 1.5 })).toThrow(/Expected an integer, got 1.5/);
  });

  // Quieter than the `take` case and still not a number the caller meant:
  // `Number("x")` is `NaN`, which binds as `null` and offsets nothing.
  test("a non-numeric skip is refused rather than bound as null", () => {
    expect(() => text({ skip: "x" })).toThrow(/Expected an integer, got "x"/);
  });

  // Already the rule inside an `include` since #72. A `skip` counts rows to
  // pass over, so there is no reading of a negative one.
  test("a negative skip is refused, as it already was on a relation node", () => {
    expect(() => text({ skip: -1 })).toThrow(
      /'skip' counts rows to pass over/,
    );
  });

  test("the refusal names the operation that was asked for", () => {
    for (const op of ["findMany", "findFirst", "count"]) {
      expect(() => text({ take: "5" }, op)).toThrow(
        new RegExp(`User\\.${op}`),
      );
    }
  });

  /**
   * `findFirst` pins `take` to 1 and never reads the caller's value, so this is
   * the one operation where the argument could have been ignored rather than
   * refused. It is refused: Prisma rejects a string there too, and refusing
   * what was *written* rather than what survived is what keeps the rule one
   * sentence long.
   */
  test("a single-row operation refuses it too, though it ignores the value", () => {
    expect(() => text({ take: "1" }, "findFirst")).toThrow(
      UnsupportedQueryError,
    );
    expect(text({ take: 1 }, "findFirst")).toBe(`${SELECT_USER} limit ?`);
  });
});

/**
 * The hazard `recountAfterSteps` guards against, pinned where the behaviour
 * actually lives.
 *
 * Dropping `undefined` keys is right — it is how an optional filter is spelled
 * — but it means a `where` built *entirely* from missing values is not a
 * narrower query, it is an unfiltered one. Any caller assembling a `where` from
 * fields it believes are on a row has to check they are there first, because
 * the failure is an arbitrary row rather than an error.
 */
describe("a where whose keys are all undefined", () => {
  test("compiles to no predicate at all, not to a miss", () => {
    const unfiltered = text({});
    expect(text({ where: { id: undefined } })).toBe(unfiltered);
    expect(text({ where: {} })).toBe(unfiltered);
    expect(text({ where: { id: undefined, email: undefined } })).toBe(
      unfiltered,
    );
  });

  test("one present key is still a predicate", () => {
    expect(text({ where: { id: 1, email: undefined } })).toBe(
      `${SELECT_USER} where "id" = ?`,
    );
  });
});

describe("select", () => {
  test("restricts the column list and the result keys", () => {
    const plan = compileRead(
      user,
      "findMany",
      { select: { id: true, email: true } },
      sqlite,
    );
    expect(plan.text).toBe('select "id", "email" from "User"');

    const shaped = plan.shape([{ id: 1, email: "a" }]) as any[];
    expect(Object.keys(shaped[0])).toEqual(["id", "email"]);
  });

  test("uses schema order, so key order in the argument does not fork the plan", () => {
    expect(text({ select: { email: true, id: true } })).toBe(
      'select "id", "email" from "User"',
    );
  });

  test("false excludes", () => {
    expect(text({ select: { id: true, email: false } })).toBe(
      'select "id" from "User"',
    );
  });

  test("rejects an unknown field, even one switched off", () => {
    expect(() => text({ select: { nope: true } })).toThrow(UnknownFieldError);
    expect(() => text({ select: { id: true, nope: false } })).toThrow(
      UnknownFieldError,
    );
  });

  // Relations inside a `select` are relation nodes, not columns, and they need
  // the registry — so they live in relations.test.ts next to the planner. What
  // belongs here is that this file's `text()` helper, which registers nothing,
  // still reports the reason legibly rather than crashing somewhere downstream.
  test("a relation in a select needs the registry", () => {
    expect(() => text({ select: { accounts: true } })).toThrow(
      /nothing has registered/,
    );
  });

  test("rejects selecting nothing", () => {
    expect(() => text({ select: {} })).toThrow(/At least one field/);
    expect(() => text({ select: { id: false } })).toThrow(/At least one field/);
  });

  test("rejects select together with include", () => {
    expect(() =>
      text({ select: { id: true }, include: { accounts: true } }),
    ).toThrow(/only one of them/);
  });
});

describe("the read operations", () => {
  test("findFirst takes one row and shapes to a row or null", () => {
    const plan = compileRead(user, "findFirst", { where: { id: 1 } }, sqlite);
    expect(plan.text).toBe(`${SELECT_USER} where "id" = ? limit ?`);
    expect(plan.bind({ where: { id: 1 } })).toEqual([1, 1]);

    expect(plan.shape([])).toBe(null);
    expect(plan.shape([{ id: 1 }])).toMatchObject({ id: 1 });
  });

  test("findUnique accepts the id and any declared unique", () => {
    expect(text({ where: { id: 1 } }, "findUnique")).toBe(
      `${SELECT_USER} where "id" = ? limit ?`,
    );
    expect(() => text({ where: { email: "a" } }, "findUnique")).not.toThrow();
    expect(() => text({ where: { publicId: "p" } }, "findUnique")).not.toThrow();
  });

  // Anything else would be a query that silently returns the first of several
  // matches.
  test("findUnique rejects a non-unique where, naming what it would accept", () => {
    expect(() => text({ where: { name: "x" } }, "findUnique")).toThrow(
      UnsupportedQueryError,
    );
    expect(() => text({ where: { name: "x" } }, "findUnique")).toThrow(
      /declares: id, publicId, email/,
    );
    expect(() => text({ where: { name: "x" } }, "findUnique")).toThrow(
      /Use findFirst/,
    );
  });

  test("findUnique rejects orderBy and pagination", () => {
    expect(() => text({ where: { id: 1 }, take: 2 }, "findUnique")).toThrow(
      /'take'/,
    );
    expect(() =>
      text({ where: { id: 1 }, orderBy: { id: "asc" } }, "findUnique"),
    ).toThrow(/'orderBy'/);
  });

  test("count selects an aggregate and shapes to a number", () => {
    const plan = compileRead(user, "count", { where: { id: 1 } }, sqlite);
    expect(plan.text).toBe(
      'select count(*) as "_count" from "User" where "id" = ?',
    );
    expect(plan.shape([{ _count: 7 }])).toBe(7);
    expect(plan.shape([])).toBe(0);
  });

  // Appending `limit` to the aggregate would cap the count's own result — which
  // is always one row — and silently report the unpaginated total. The
  // differential harness caught exactly that.
  test("a paginated count wraps the row query in a subquery", () => {
    const args = { take: 2, where: { id: 1 } };
    const plan = compileRead(user, "count", args, sqlite);
    expect(plan.text).toBe(
      'select count(*) as "_count" from (select "id" from "User" ' +
        'where "id" = ? order by "id" asc limit ?) as "sub"',
    );
    expect(plan.bind(args)).toEqual([1, 2]);
  });
});

describe("compound uniques", () => {
  // The template's SocialAccount declares @@unique([username, provider]), which
  // Prisma exposes as a single `username_provider` key holding both members.
  const composite = {
    ...mapped,
    name: "SocialAccount",
    uniques: [["isArchived", "occurredAt"]],
    primaryKey: [] as string[],
  };

  // Asserted on the compiled SQL, not with `.not.toThrow(/re/)` — that form
  // passes both when nothing throws and when the *wrong* thing throws, which is
  // how this exact case shipped broken.
  test("destructures Prisma's joined compound form into an AND", () => {
    const args = {
      where: {
        isArchived_occurredAt: { isArchived: true, occurredAt: new Date(5) },
      },
    };
    const plan = compileRead(composite, "findUnique", args, sqlite);

    expect(plan.text).toBe(
      'select "id", "is_archived", "occurred_at", "payload", "size" ' +
        'from "audit_log" where ("is_archived" = ? and "occurred_at" = ?) ' +
        "limit ?",
    );
    expect(plan.bind(args)).toEqual([1, 5, 1]);
  });

  test("rejects a compound key missing a member", () => {
    expect(() =>
      compileRead(
        composite,
        "findUnique",
        { where: { isArchived_occurredAt: { isArchived: true } } },
        sqlite,
      ),
    ).toThrow(/Missing 'occurredAt'/);
  });

  test("rejects only one half of a compound key", () => {
    expect(() =>
      compileRead(
        composite,
        "findUnique",
        { where: { isArchived: true } },
        sqlite,
      ),
    ).toThrow(/isArchived_occurredAt/);
  });

  test("still reports a genuinely unknown key as an unknown field", () => {
    expect(() =>
      compileRead(composite, "findMany", { where: { nope_nope: {} } }, sqlite),
    ).toThrow(UnknownFieldError);
  });
});

describe("postgres", () => {
  test("numbers its placeholders", () => {
    const args = { where: { email: "a", id: 1 }, take: 2 };
    const plan = compileRead(user, "findMany", args, postgres);
    expect(plan.text).toBe(
      `${SELECT_USER} where ("email" = $1 and "id" = $2) ` +
        `order by "id" asc limit $3`,
    );
    expect(plan.bind(args)).toEqual(["a", 1, 2]);
  });

  // The reason `inList` is on the dialect rather than in the compiler: one text
  // for every list length means one plan and one prepared statement, where
  // SQLite needs one of each per distinct length.
  test("binds an in-list as a single array parameter", () => {
    const args = { where: { id: { in: [1, 2, 3] } } };
    const plan = compileRead(user, "findMany", args, postgres);
    expect(plan.text).toBe(`${SELECT_USER} where "id" = any ($1)`);
    // A Postgres array *literal*, not a JS array: Bun's driver refuses an array
    // bound to `= any($1)`. Still exactly one parameter, and still nothing in
    // the text.
    expect(plan.bind(args)).toEqual([`{"1","2","3"}`]);

    // ...and the text does not change with the length.
    expect(
      compileRead(user, "findMany", { where: { id: { in: [1] } } }, postgres)
        .text,
    ).toBe(plan.text);
  });

  test("accepts offset without a limit", () => {
    const args = { skip: 4 };
    const plan = compileRead(user, "findMany", args, postgres);
    expect(plan.text).toBe(`${SELECT_USER} order by "id" asc offset $1`);
    expect(plan.bind(args)).toEqual([4]);
  });

  test("supports mode: insensitive, which sqlite refuses", () => {
    const args = { where: { email: { contains: "A", mode: "insensitive" } } };
    expect(compileRead(user, "findMany", args, postgres).text).toBe(
      `${SELECT_USER} where "email" ilike $1`,
    );
    expect(() => compileRead(user, "findMany", args, sqlite)).toThrow(
      /insensitive/,
    );
  });
});

/**
 * `cursor` and `distinct` are **decisions, not gaps**, and the error says so.
 *
 * The distinction is one a caller can act on: "yet" means wait for a release,
 * "will not" means change the code. They shared one error until #68, which is
 * how `docs/orm.md` came to list an argument under *Not in scope* while the
 * runtime said "yet".
 */
describe("arguments refused by design", () => {
  test.each([
    ["cursor", { cursor: { id: 1 } }],
    ["distinct", { distinct: ["email"] }],
  ])("%s says it is a decision, not a gap", (argument, args) => {
    expect(() => text(args)).toThrow(UnsupportedByDesignError);
    expect(() => text(args)).toThrow(
      `gemi ORM does not implement '${argument}' (User.findMany), and this is ` +
        `a decision rather than a gap.`,
    );
    // Still an `UnsupportedQueryError`, so a caller that does not care which
    // kind it is keeps working.
    expect(() => text(args)).toThrow(UnsupportedQueryError);
  });

  /** Each names what to reach for instead — #61's rule. */
  test("distinct explains why Prisma's own version is the problem", () => {
    expect(() => text({ distinct: ["email"] })).toThrow(/in memory/);
    expect(() => text({ distinct: ["email"] })).toThrow(/DB\.query/);
  });

  test("cursor names the failure it would have", () => {
    expect(() => text({ cursor: { id: 1 } })).toThrow(/total.* ordering/);
    expect(() => text({ cursor: { id: 1 } })).toThrow(/skips or repeats rows/);
  });

  test("an argument that really is unimplemented still says 'yet'", () => {
    expect(() => text({ nonsense: 1 } as never)).toThrow(
      `gemi ORM does not support 'nonsense' yet (User.findMany).`,
    );
  });

  test("a to-many relation filter with no operator names the operators", () => {
    expect(() => text({ where: { accounts: { email: "a@b.c" } } })).toThrow(
      /every, none, some/,
    );
  });

  test("an unknown operator, named precisely", () => {
    expect(() => text({ where: { email: { search: "x" } } })).toThrow(
      /'where\.email\.search'/,
    );
  });

  /**
   * `count({ select })` used to be refused as aggregate territory, and that was
   * the right call while there was no aggregate to put it beside. It is a
   * per-field count now — `count("email")`, the rows where the column is not
   * null — and it routes through `compileAggregate` so the two cannot disagree
   * about what that means.
   */
  test("count with a select is a per-field count, not the plain total", () => {
    expect(text({ select: { email: true } }, "count")).toContain(
      `count("email")`,
    );
    expect(text({ select: { _all: true } }, "count")).toContain(`count(*)`);
    // ...and a count with no select is still the plain total.
    expect(text({}, "count")).toContain(`count(*) as "_count"`);
  });

  test("a select naming nothing is refused rather than counted as everything", () => {
    expect(() => text({ select: {} }, "count")).toThrow(
      /must name at least one field/,
    );
  });

  // Validation must not depend on whether a different argument happens to be
  // present too.
  test("count validates orderBy whether or not it paginates", () => {
    expect(() => text({ orderBy: { nope: "asc" } }, "count")).toThrow(
      UnknownFieldError,
    );
    expect(() => text({ orderBy: { nope: "asc" }, take: 1 }, "count")).toThrow(
      UnknownFieldError,
    );
  });

  // `String(null)` would make the pattern `%null%` — a query that runs and
  // returns the wrong rows. Prisma raises instead, and so do we.
  test.each(["contains", "startsWith", "endsWith"])(
    "%s rejects a non-string operand",
    (operator) => {
      expect(() => text({ where: { email: { [operator]: null } } })).toThrow(
        /Expected a string, received null/,
      );
      expect(() => text({ where: { email: { [operator]: 5 } } })).toThrow(
        /Expected a string, received number/,
      );
    },
  );

  test("contains rejects a non-string column", () => {
    expect(() => text({ where: { id: { contains: "x" } } })).toThrow(
      /'id' is a Int, and contains only applies to strings/,
    );
  });

  test("an unknown where key lists the known fields", () => {
    expect(() => text({ where: { emial: "x" } })).toThrow(
      /'emial' is not a field on model User/,
    );
  });
});

// The property the plan cache is built on, asserted directly.
/**
 * #61's second half: **every refusal says what to do instead.**
 *
 * The first half — separating "not yet" from "out of scope" — landed in #78 as
 * `UnsupportedByDesignError`. This is the other one: `detail` was optional, and
 * the call sites that omitted it were the highest-traffic ones, on the path a
 * typo takes. They said only *that* something was refused, to the reader least
 * likely to know why.
 *
 * `detail` is required now, so `tsc` enforces it rather than a convention —
 * and the enforcement found three more sites than a search for the pattern
 * did, which is the argument for the type over the grep.
 *
 * The assertion is deliberately not "the message contains X": it is that a
 * refusal is more than its first sentence. A call site added later with an
 * empty string would satisfy the compiler and fail here.
 */
/**
 * The three categories a refusal can be in, and the sentence each owes — the
 * completion of #61.
 *
 *   not implemented yet     UnsupportedQueryError      wait for a release
 *   decided against         UnsupportedByDesignError   change the call   (#78)
 *   implemented, bad value  InvalidArgumentError       fix the value
 *
 * The third is why "yet" was corrected four times at four call sites (#82, #88,
 * #100, #101) before the issue that owns it was found: `take` *is* implemented,
 * `"-2"` is not a take, and telling that caller to wait for a release sends
 * them to a changelog when the fix is one character in their own code.
 *
 * All three subclass `UnsupportedQueryError`, so a handler catching the base
 * class is unaffected — the specific classes are for the reader.
 */
describe("a refusal says which kind of refusal it is", () => {
  test.each([
    ["a value of the wrong type", { take: "-2" }, InvalidArgumentError, /^Invalid 'take'/],
    ["a value out of range", { skip: -1 }, InvalidArgumentError, /^Invalid 'skip'/],
    ["a direction that is not one", { orderBy: { id: "sideways" } }, InvalidArgumentError, /^Invalid/],
    ["a mode that is not one", { where: { email: { contains: "x", mode: "loud" } } }, InvalidArgumentError, /^Invalid/],
    ["an argument that does not exist", { nope: 1 }, UnsupportedQueryError, /does not support .* yet/],
    ["an argument refused by design", { distinct: ["id"] }, UnsupportedByDesignError, /decision rather than a gap/],
  ])("%s", (_label, args, kind, shape) => {
    expect(() => text(args)).toThrow(kind as never);
    expect(() => text(args)).toThrow(shape as RegExp);
  });

  /**
   * The property that matters more than the wording: a bad *value* must never
   * be reported as a missing *feature*. That is the sentence that sent four
   * PRs to four call sites.
   */
  test.each([
    ["take", { take: "-2" }],
    ["skip", { skip: -1 }],
    ["orderBy", { orderBy: { id: "sideways" } }],
    ["mode", { where: { email: { contains: "x", mode: "loud" } } }],
  ])("a bad value for %s never says 'yet'", (_label, args) => {
    expect(() => text(args)).not.toThrow(/yet/);
  });

  /**
   * The edge, asserted so it is a decision rather than an oversight.
   *
   * An argument that is not in the grammar at all keeps "yet", because the same
   * check refuses a typo and a real Prisma argument this ORM has not
   * implemented, and nothing there can tell them apart. What carries the reader
   * is the *next* sentence, which #102 made mandatory: it lists what the
   * operation does take.
   */
  test("an argument outside the grammar keeps 'yet', and says what is taken", () => {
    expect(() => text({ nope: 1 })).toThrow(/yet/);
    expect(() => text({ nope: 1 })).toThrow(/findMany takes .*where/);
  });

  /** ...and every one of them still answers to the base class. */
  test("all three are catchable as UnsupportedQueryError", () => {
    for (const args of [{ take: "-2" }, { nope: 1 }, { distinct: ["id"] }]) {
      expect(() => text(args)).toThrow(UnsupportedQueryError);
    }
  });
});

describe("every refusal says what to do instead", () => {
  const REFUSALS: [string, () => unknown][] = [
    ["an argument the read does not take", () => text({ nope: 1 })],
    ["an argument the write does not take", () =>
      compileWrite(user, "create", { data: { email: "a@b.c" }, nope: 1 } as any, sqlite)],
    ["an operator that is not one", () => text({ where: { email: { weird: 1 } } })],
    ["a mode that is neither", () =>
      text({ where: { email: { contains: "x", mode: "loud" } } })],
    ["an operation that is not one", () => compile(user, "frobnicate" as any, {}, sqlite)],
  ];

  test.each(REFUSALS)("%s", (_label, run) => {
    let message = "";
    try {
      run();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe("");

    // The prefix is `does not support 'x' yet (Model.op).` — a refusal that
    // stops there is the thing #61 is about, so the detail has to follow it.
    const detail = message.slice(message.indexOf(").") + 2).trim();
    expect(detail.length).toBeGreaterThan(0);
  });

  /**
   * The two errors that already met this standard, and set it: both enumerate
   * the valid names rather than only rejecting the invalid one.
   */
  test("an unknown field still lists the fields", () => {
    expect(() => text({ where: { nope: 1 } })).toThrow(/Known fields:/);
  });
});

describe("compile is a function of shape, not values", () => {
  test("the same shape with different values is byte identical", () => {
    const a = compileRead(user, "findMany", { where: { email: "a" } }, sqlite);
    const b = compileRead(user, "findMany", { where: { email: "zz" } }, sqlite);
    expect(a.text).toBe(b.text);
  });

  test("key order does not change the emitted SQL", () => {
    expect(text({ where: { id: 1, email: "x" } })).toBe(
      text({ where: { email: "x", id: 1 } }),
    );
  });

  test("an explicit undefined is treated as absent", () => {
    expect(text({ where: { email: undefined, id: 3 } })).toBe(
      `${SELECT_USER} where "id" = ?`,
    );
    expect(text({ take: undefined, where: { id: 1 } })).toBe(
      `${SELECT_USER} where "id" = ?`,
    );
  });

  test("never emits select *", () => {
    expect(text({})).not.toContain("*");
  });

  test("reads table and column names from the schema, never the field name", () => {
    expect(
      compileRead(mapped, "findMany", { where: { isArchived: true } }, sqlite)
        .text,
    ).toBe(
      'select "id", "is_archived", "occurred_at", "payload", "size" ' +
        'from "audit_log" where "is_archived" = ?',
    );
  });

  test("encodes parameters through the dialect", () => {
    const args = { where: { occurredAt: new Date(1772093271771) } };
    expect(compileRead(mapped, "findMany", args, sqlite).bind(args)).toEqual([
      1772093271771,
    ]);
  });

  test("never interpolates a value into the text", () => {
    const evil = "'; drop table User; --";
    const args = { where: { email: evil } };
    expect(text(args)).toBe(`${SELECT_USER} where "email" = ?`);
    expect(bind(args)).toEqual([evil]);
  });
});

/**
 * The parameter ceiling is a *statement* property, not a `createMany` one.
 *
 * It first shipped inside `compileCreateMany`, on the reasoning that
 * `rows × columns` was the only count that scaled with the caller's data. On
 * SQLite an `in` list binds one placeholder per element, so a read walks into
 * the same driver limit — and such a list is routinely request-derived, which
 * is the case worth naming rather than letting the driver report obscurely.
 */
describe("the parameter ceiling applies to reads", () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => index);

  test("a large in list is refused on sqlite, by name", () => {
    const args = { where: { id: { in: ids(40_000) } } };

    expect(() => compileRead(user, "findMany", args, sqlite)).toThrow(
      ParameterLimitError,
    );
    expect(() => compileRead(user, "findMany", args, sqlite)).toThrow(
      /would bind 40000 parameters.*accepts at most 32766/,
    );
  });

  test("the message says why the count is what it is", () => {
    expect(() =>
      compileRead(user, "findMany", { where: { id: { in: ids(40_000) } } }, sqlite),
    ).toThrow(/each element of an 'in' list counts separately/);
  });

  // `= any($1)` is one parameter however long the array, so the same query is
  // fine here. This asymmetry is the reason the limit is a dialect capability
  // rather than a constant.
  test("the same list is one parameter on postgres", () => {
    const args = { where: { id: { in: ids(40_000) } } };
    const plan = compileRead(user, "findMany", args, postgres);

    expect(plan.text).toContain("= any ($1)");
    expect(plan.bind(args)).toHaveLength(1);
  });

  test("a list at exactly the sqlite limit still compiles", () => {
    const args = { where: { id: { in: ids(32_766) } } };
    expect(() => compileRead(user, "findMany", args, sqlite)).not.toThrow();
  });

  // Two lists in one statement are one statement's worth of parameters — which
  // is the reason the check reads the rendered count rather than any single
  // clause's length.
  test("the ceiling counts the whole statement, not one clause", () => {
    const args = {
      where: {
        AND: [
          { id: { in: ids(20_000) } },
          { globalRole: { in: ids(20_000) } },
        ],
      },
    };
    expect(() => compileRead(user, "findMany", args, sqlite)).toThrow(
      ParameterLimitError,
    );
  });
});

/**
 * Column qualification, for iteration 9.
 *
 * A lateral relation strategy folds children into the root statement, which puts a
 * second table in scope and makes a bare `"id"` ambiguous. `WhereContext.qualifier`
 * is how a column reference becomes `"User"."id"` — the table's own name rather
 * than an invented alias, because Postgres lets a lateral subquery reference the
 * outer table by name.
 *
 * The property that matters most here is the *absence* case: with no qualifier the
 * emitted SQL is byte-identical to what it was before this existed, which is what
 * keeps invariant 2 and every assertion above untouched. An earlier version of the
 * iteration-9 plan called for unconditional aliasing and predicted it would change
 * emitted SQL for every read; making it conditional means it changes none.
 */
describe("column qualification", () => {
  test("no qualifier emits exactly what it always did", () => {
    // The same assertion as the equality test at the top of this file, restated
    // here as the guarantee rather than as a coincidence.
    expect(
      compileWhere(user, { email: "a@b.c" }, { dialect: sqlite, operation: "findMany" }, (a) => a),
    ).not.toBeNull();

    expect(text({ where: { email: "a@b.c" } })).toBe(
      `${SELECT_USER} where "email" = ?`,
    );
  });

  test("a qualifier prefixes every column the where names", () => {
    const compiled = compileWhere(
      user,
      { email: "a@b.c", globalRole: 2 },
      { dialect: sqlite, operation: "findMany", qualifier: `"User".` },
      (args) => args,
    );

    const { text: rendered } = render(compiled!, sqlite, {
      model: "User",
      operation: "findMany",
    });

    // Parenthesised, as any multi-predicate group is — the qualifier does not
    // change the grouping, only the identifiers inside it.
    expect(rendered).toBe(`("User"."email" = ? and "User"."globalRole" = ?)`);
  });

  test("it reaches nested groups and negations too", () => {
    const compiled = compileWhere(
      user,
      { OR: [{ email: "a@b.c" }, { NOT: { globalRole: 2 } }] },
      { dialect: sqlite, operation: "findMany", qualifier: `"User".` },
      (args) => args,
    );

    const { text: rendered } = render(compiled!, sqlite, {
      model: "User",
      operation: "findMany",
    });

    // Every column, at every depth — a qualifier that only reached the top level
    // would produce ambiguity errors on exactly the queries a lateral join makes
    // interesting.
    expect(rendered).not.toMatch(/(?<!")\bemail"/);
    expect(rendered).toContain(`"User"."email"`);
    expect(rendered).toContain(`"User"."globalRole"`);
  });

  test("a qualifier does not disturb the parameters", () => {
    const args = { email: "a@b.c" };
    const compiled = compileWhere(
      user,
      args,
      { dialect: sqlite, operation: "findMany", qualifier: `"User".` },
      () => args,
    );

    const { binders } = render(compiled!, sqlite, {
      model: "User",
      operation: "findMany",
    });

    // Qualification is an identifier concern; values stay parameters.
    expect(binders).toHaveLength(1);
  });
});

/**
 * The compiler side of a fold-into-the-root strategy — iteration 9's deliverable 2.
 *
 * Tested with a *fake* strategy rather than the lateral one, deliberately. What is
 * being checked here is the compiler's contract: does it qualify, append, join and
 * decode. Doing that against a real lateral strategy would test both at once and
 * blame the wrong one when either broke — and the fake can produce shapes a real
 * strategy would not, which is how the qualifier's reach gets checked.
 */
describe("root contributions in compileRead", () => {
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Account", class { static $schema = account });
  });

  afterEach(() => registry.clearRegistry());

  /** A strategy that folds, with SQL simple enough to assert on exactly. */
  function foldingStrategy(): RelationStrategy {
    return {
      name: "folded",
      plan(request) {
        return {
          as: request.as,
          kind: request.relation.kind,
          parentFields: ["id"],
          strategy: "folded",
          root: {
            column: sql(`"folded"."data" as ${request.dialect.quoteIdent(request.as)}`),
            join: sql(` left join lateral (select 1 as "data") as "folded" on true`),
            decode: (value) => ({ decoded: value }),
          },
          load: async () => {
            throw new Error("a folded relation must not be loaded");
          },
        };
      },
    };
  }

  function compiled(args: any) {
    return compileRead(user, "findMany", args, sqlite, foldingStrategy());
  }

  test("the root's columns are qualified when a relation folds", () => {
    // A relation has to be in the args for anything to fold — the qualifier is
    // derived from the plans, so no relation means no qualifier, which is the
    // whole point of it being conditional.
    const { text: rendered } = compiled({
      select: { id: true, email: true, accounts: true },
    });

    // Qualified by the table's own name — no alias is introduced, because
    // Postgres lets a lateral subquery reference the outer table by name.
    expect(rendered).toContain(`"User"."id"`);
    expect(rendered).toContain(`"User"."email"`);
  });

  test("the contributed column and join are both emitted", () => {
    const { text: rendered } = compiled({ include: { accounts: true } });

    expect(rendered).toContain(`"folded"."data" as "accounts"`);
    expect(rendered).toContain(`left join lateral`);
    // The join lands after the `from` and before the `where`.
    expect(rendered.indexOf("left join")).toBeGreaterThan(rendered.indexOf(" from "));
  });

  test("the where and orderBy are qualified too", () => {
    const { text: rendered } = compiled({
      include: { accounts: true },
      where: { email: "a@b.c" },
      orderBy: { id: "asc" },
    });

    // An unqualified column in either position is an ambiguity error on exactly
    // the queries a fold makes interesting, so both have to be reached.
    expect(rendered).toContain(`where "User"."email" = ?`);
    expect(rendered).toContain(`order by "User"."id" asc`);
  });

  test("the contributed column is placed after the scalars", () => {
    const { text: rendered } = compiled({ select: { id: true, accounts: true } });

    const columns = rendered.slice("select ".length, rendered.indexOf(" from "));
    expect(columns.split(", ")).toEqual([
      `"User"."id"`,
      `"folded"."data" as "accounts"`,
    ]);
  });

  test("shape runs the strategy's decode instead of the empty placeholder", () => {
    const plan = compiled({ include: { accounts: true } });

    const shaped = plan.shape([{ id: 1, accounts: "raw" }]) as any[];

    // The shaper wrote `[]` because it knows nothing about strategies; the
    // decode replaced it.
    expect(shaped[0].accounts).toEqual({ decoded: "raw" });
  });

  test("a decode that sees no column still runs, so an absent value is its problem", () => {
    const plan = compiled({ include: { accounts: true } });
    const shaped = plan.shape([{ id: 1 }]) as any[];

    // `json_agg` over zero rows returns NULL, so handling absence is exactly what
    // a real strategy's decode must do — the compiler must not decide for it.
    expect(shaped[0].accounts).toEqual({ decoded: undefined });
  });

  test("the plan reports the folding strategy", () => {
    expect(compiled({ include: { accounts: true } }).strategies).toEqual([
      "folded",
    ]);
  });

  /** The load-bearing negative: nothing folds, nothing changes. */
  test("with the batched strategy the SQL is byte-identical", () => {
    const args = { where: { email: "a@b.c" }, include: { accounts: true } };
    const withFold = compiled(args).text;
    const without = compileRead(user, "findMany", args, sqlite).text;

    // The batched path emits exactly what it always did — unqualified, no join.
    expect(without).toBe(`${SELECT_USER} where "email" = ?`);
    // ...and the folding one is genuinely different, or this proves nothing.
    expect(withFold).not.toBe(without);
  });
});

/**
 * JSON path filters (#70's second half).
 *
 * The differential harness owns "does it match Prisma" — and it has to, twice,
 * because the *path grammar itself* differs between the dialects. What lives
 * here is the injection invariant and the refusals, neither of which a result
 * comparison can see.
 */
describe("json path filters", () => {
  const jsonUser: any = {
    ...user,
    fields: {
      ...user.fields,
      metadata: { name: "metadata", column: "metadata", type: "Json" },
    },
  };

  const sqliteText = (args: any) =>
    compileRead(jsonUser, "findMany", args, sqlite).text;
  const pgText = (args: any) =>
    compileRead(jsonUser, "findMany", args, postgres).text;

  /**
   * The point of the whole feature, and the one place a caller's *value*
   * decides part of an expression's meaning. Both dialects take the path as a
   * parameter — Postgres's `#>` a `text[]`, SQLite's `json_extract` a string —
   * so nothing has to be bent to keep it out of the SQL text.
   */
  test("the path is bound, never interpolated", () => {
    const args = { where: { metadata: { path: "$.plan", equals: "pro" } } };
    expect(sqliteText(args)).not.toContain("plan");
    expect(sqliteText(args)).toContain(`json_extract("metadata", ?)`);
    expect(
      compileRead(jsonUser, "findMany", args, sqlite).bind(args),
    ).toEqual(["$.plan", "pro"]);

    const pgArgs = { where: { metadata: { path: ["plan"], equals: "pro" } } };
    expect(pgText(pgArgs)).not.toContain("plan");
    expect(pgText(pgArgs)).toContain(`"metadata" #>> $1`);
  });

  /** A path that is trying to be SQL is a value like any other. */
  test("a path that looks like SQL stays a parameter", () => {
    const args = {
      where: { metadata: { path: `$."a'); drop table User; --"`, equals: "x" } },
    };
    expect(sqliteText(args)).not.toContain("drop table");
    expect(sqliteText(args)).toContain(`json_extract("metadata", ?)`);
  });

  /**
   * Prisma's own split, measured on both: the generated client refuses an array
   * path on SQLite and a string path on Postgres. The refusal here says which
   * form *this* database wants rather than letting the driver fail.
   */
  test("each dialect refuses the other's path grammar", () => {
    expect(() =>
      sqliteText({ where: { metadata: { path: ["plan"], equals: "x" } } }),
    ).toThrow(/JSONPath string/);

    expect(() =>
      pgText({ where: { metadata: { path: "$.plan", equals: "x" } } }),
    ).toThrow(/array of keys/);
  });

  test("a path on a column that is not Json is refused by type", () => {
    expect(() =>
      sqliteText({ where: { email: { path: "$.a", equals: "x" } } }),
    ).toThrow(/is a String column/);
  });

  test("a bare path with no filter is refused, as Prisma refuses it", () => {
    expect(() =>
      sqliteText({ where: { metadata: { path: "$.plan" } } }),
    ).toThrow(/needs a filter beside it/);
  });

  /**
   * #371, the first of three. `applied` was built from `Object.keys` alone, so
   * the one branch in this file that did **not** treat `undefined` as absent
   * was the one where the operand goes on to be bound: the scalar loop skips it
   * (`if (operand === undefined …) continue`) and the dispatch into this branch
   * skips a `path` that is `undefined`.
   *
   * The two spellings therefore disagreed — the key omitted got a loud, correct
   * refusal, and the key present-but-undefined compiled to `= NULL`, a
   * predicate no row can satisfy. An optional filter assembled from a form or a
   * query string carries exactly that.
   *
   * Prisma answers both identically: P2019 *"A JSON path cannot be set without
   * a scalar filter."* Measured on a generated 6.19.2 client against Postgres.
   */
  test("an undefined operand is absent, so the path is bare", () => {
    for (const key of ["equals", "not", "string_contains", "array_contains"]) {
      expect(() =>
        pgText({ where: { metadata: { path: ["a"], [key]: undefined } } }),
      ).toThrow(/needs a filter beside it/);
    }

    // A *misspelled* key holding `undefined` is absent too, so the bare-path
    // refusal wins over the unknown-operator one — which is the order Prisma
    // resolves them in: `{ path: ["a"], equalz: undefined }` answers P2019
    // there, and `{ path: ["a"], equalz: 1 }` answers *"Unknown argument
    // `equalz`. Did you mean `equals`?"*.
    expect(() =>
      pgText({ where: { metadata: { path: ["a"], equalz: undefined } } }),
    ).toThrow(/needs a filter beside it/);
    expect(() =>
      pgText({ where: { metadata: { path: ["a"], equalz: 1 } } }),
    ).toThrow(/A JSON path filter takes/);

    // `path: undefined` is absent too — the dispatch into this branch tests
    // `filter.path !== undefined`, so the filter falls through to the column
    // arm rather than becoming a bare path. That half was already right before
    // this change; asserted here so the rule holds on both sides of the
    // dispatch. Prisma answers it the same way — `{ path: undefined,
    // equals: { a: 1 } }` is a filter on the column there too.
    const columnArgs = {
      where: { metadata: { path: undefined, equals: { a: 1 } } },
    };
    expect(pgText(columnArgs)).toContain(`"metadata" = $1::text::jsonb`);
    expect(pgText(columnArgs)).not.toContain("#>>");
    expect(
      compileRead(jsonUser, "findMany", columnArgs, postgres).bind(columnArgs),
    ).toEqual([`{"a":1}`]);

    // ...and one live operator beside it is still a filter, so the guard drops
    // keys rather than the whole operand.
    const args = { where: { metadata: { path: ["a"], equals: 1, gt: undefined } } };
    expect(pgText(args)).toContain(`("metadata" #>> $1) = $2`);
    // `gt` compiles to `cast(… as real) >`, so its absence is visible.
    expect(pgText(args)).not.toContain("as real");
    expect(compileRead(jsonUser, "findMany", args, postgres).bind(args)).toEqual([
      `{"a"}`,
      "1",
    ]);
  });

  /**
   * `array_contains` and the numeric comparisons are refused by Prisma's own
   * client on SQLite — *"Unknown argument"* — so implementing them would make
   * gemi answer a query the oracle cannot check. The message says it is a
   * difference between the databases rather than a gap.
   */
  test("a filter this dialect cannot express names the dialect", () => {
    for (const filter of [{ array_contains: "a" }, { gt: 2 }, { lte: 9 }]) {
      expect(() =>
        sqliteText({ where: { metadata: { path: "$.a", ...filter } } }),
      ).toThrow(/not available on sqlite/);
    }

    // ...and all three compile on postgres.
    for (const filter of [{ array_contains: "a" }, { gt: 2 }, { lte: 9 }]) {
      expect(() =>
        pgText({ where: { metadata: { path: ["a"], ...filter } } }),
      ).not.toThrow();
    }
  });

  test("an operator that is not a JSON filter names itself", () => {
    expect(() =>
      sqliteText({ where: { metadata: { path: "$.a", startsWith: "x" } } }),
    ).toThrow(/metadata.startsWith/);
  });

  /**
   * The gap review found: `compileFieldFilter` refuses a bare sentinel *above*
   * the `path` branch and refuses `AnyNull` under a non-`equals`/`not` operator
   * *below* it, so a sentinel inside a JSON filter reached neither and went
   * straight to the binder. Postgres compared against the literal text
   * `Prisma.DbNull`; SQLite bound the sentinel object. Zero rows, no error —
   * the class #259 and #266 exist to close.
   *
   * Refused rather than mapped, because an extracted value cannot tell an
   * absent key from a JSON null: `#>>` yields NULL for both, so there is no
   * answer to give that is not silently wrong half the time.
   */
  describe("a Json null sentinel inside a path filter is refused", () => {
    // A class, for the reason `json-null.test.ts` spells out: a method in an
    // object literal is enumerable, `for…in` walks it, and the recogniser would
    // reject the fake while accepting Prisma's real one.
    const sentinel = (tag: string): object => {
      class Sentinel {
        toString() {
          return tag;
        }
      }
      return new Sentinel();
    };

    const sentinels = [
      ["DbNull", sentinel("Prisma.DbNull")],
      ["JsonNull", sentinel("Prisma.JsonNull")],
      ["AnyNull", sentinel("Prisma.AnyNull")],
    ] as const;

    test.each(sentinels)("%s on sqlite", (_name, sentinel) => {
      expect(() =>
        sqliteText({ where: { metadata: { path: "$.a", equals: sentinel } } }),
      ).toThrow(InvalidArgumentError);
    });

    test.each(sentinels)("%s on postgres", (_name, sentinel) => {
      expect(() =>
        pgText({ where: { metadata: { path: ["a"], equals: sentinel } } }),
      ).toThrow(InvalidArgumentError);
    });

    /** Nothing of the sentinel reaches the SQL, which is the actual defect. */
    test("it never becomes a bound literal", () => {
      let text = "";
      try {
        text = pgText({
          where: { metadata: { path: ["a"], equals: sentinel("Prisma.DbNull") } },
        });
      } catch {
        // expected
      }
      expect(text).not.toContain("Prisma.DbNull");
    });
  });

  /**
   * The scalar `contains` refuses a non-string operand, with a comment saying
   * why: `String(null)` makes the pattern `%null%`, "a query that runs and
   * returns the wrong rows". The JSON string filters reintroduced that shape.
   * `like NULL` matches nothing and raises nothing.
   */
  test.each([
    ["string_contains", null],
    ["string_contains", 5],
    ["string_starts_with", null],
    ["string_ends_with", { a: 1 }],
  ])("%s refuses a non-string operand", (key, operand) => {
    expect(() =>
      sqliteText({ where: { metadata: { path: "$.a", [key]: operand } } }),
    ).toThrow(InvalidArgumentError);
  });

  /**
   * On Postgres the comparison binds `String(raw)` because `#>>` yields text,
   * so an object operand became the string `"[object Object]"` and matched
   * nothing. Refused rather than implemented: answering it properly needs the
   * `#>` + `::jsonb` form, which is Postgres-only, and a filter that works on
   * one dialect and silently misses on the other is the thing this file refuses
   * everywhere else.
   */
  test("equals with a non-scalar operand is refused, not bound as a string", () => {
    for (const operand of [{ b: 1 }, ["a"]]) {
      expect(() =>
        pgText({ where: { metadata: { path: ["a"], equals: operand } } }),
      ).toThrow(UnsupportedQueryError);
      expect(() =>
        sqliteText({ where: { metadata: { path: "$.a", not: operand } } }),
      ).toThrow(UnsupportedQueryError);
    }

    // `array_contains` is the exception, because containment is precisely the
    // operator whose right-hand side is a document.
    expect(() =>
      pgText({ where: { metadata: { path: ["a"], array_contains: ["x"] } } }),
    ).not.toThrow();
  });

  /**
   * #371, the second of three. `null` fell between `assertJsonOperand`'s two
   * branches — the string branch refuses a non-string, the object branch tested
   * `operand !== null` first — so it reached the binder and compiled to
   * `("metadata" #>> $1) = $2` bound to NULL. `= NULL` is NULL rather than true
   * on both dialects: the query runs, raises nothing, and matches no row.
   *
   * **Prisma does answer this one**, which is why it is a refusal rather than a
   * gap being closed. Measured on a generated 6.19.2 client against Postgres:
   * `{ path: ["a"], equals: null }` compiles to
   * `("metadata"#>ARRAY[$1]::text[])::jsonb::jsonb = $2` and returns the rows
   * whose `a` is the JSON value `null` — byte-identical SQL and identical rows
   * to `equals: Prisma.JsonNull`. It can, because it extracts with `#>` and
   * compares as `jsonb`; gemi extracts with `#>>`, which yields SQL NULL for an
   * absent key and a JSON null alike. That is the same collapse the sentinel
   * refusal above names, so the same answer follows.
   *
   * `array_contains` is refused too, and its mechanism is the other one:
   * `jsonArrayContains` binds the operand raw, so `null` arrives as SQL NULL
   * and `x @> NULL` is NULL. Prisma binds it as the JSON value and runs a real
   * containment test.
   */
  describe("null at a path is refused", () => {
    /**
     * **Each row asserts its message, not just `InvalidArgumentError`**, and
     * that is what pins the two things the class alone cannot see.
     *
     * The `string_*` rows already threw before this change, from the non-string
     * guard, with the `'%null%'` reasoning — so a class assertion passes either
     * way and leaves the new guard's *placement* unpinned. It sits deliberately
     * **after** that guard so the better message survives; moving it above used
     * to leave all 153 tests green while `string_contains: null` silently swapped
     * its message for the generic one.
     *
     * The `array_contains` row asserts the other sentence for the same kind of
     * reason: that operator does not extract with `#>>`, so its refusal names
     * the raw bind and `x @> NULL` instead of the text collapse.
     */
    const postgresOperators = [
      ["equals", /null cannot be compared through a JSON path/],
      ["not", /null cannot be compared through a JSON path/],
      ["gt", /null cannot be compared through a JSON path/],
      ["lte", /null cannot be compared through a JSON path/],
      ["string_contains", /'%null%', which runs and returns the wrong rows/],
      ["array_contains", /null cannot be tested for containment/],
    ] as const;

    test.each(postgresOperators)("%s on postgres", (key, message) => {
      const compile = () =>
        pgText({ where: { metadata: { path: ["a"], [key]: null } } });
      expect(compile).toThrow(InvalidArgumentError);
      expect(compile).toThrow(message);
    });

    // SQLite offers only the six its dialect answers; the other four raise the
    // dialect refusal first, which is a different message and already pinned.
    test.each([
      ["equals", /null cannot be compared through a JSON path/],
      ["not", /null cannot be compared through a JSON path/],
      ["string_ends_with", /'%null%', which runs and returns the wrong rows/],
    ] as const)("%s on sqlite", (key, message) => {
      const compile = () =>
        sqliteText({ where: { metadata: { path: "$.a", [key]: null } } });
      expect(compile).toThrow(InvalidArgumentError);
      expect(compile).toThrow(message);
    });

    /**
     * The load-bearing negative: only the *bare* operand is refused. A `null`
     * inside a document under `array_contains` is an ordinary JSON value, and
     * containment against `[null]` is a question Postgres answers.
     */
    test("a null inside an array_contains document still compiles", () => {
      const args = { where: { metadata: { path: ["a"], array_contains: [null] } } };
      expect(pgText(args)).toContain(`("metadata" #> $1) @> $2::jsonb`);
      expect(compileRead(jsonUser, "findMany", args, postgres).bind(args)).toEqual([
        `{"a"}`,
        [null],
      ]);
    });

    /**
     * Nothing of it reaches the SQL, which is the actual defect. The message is
     * asserted alongside because a bare `text === ""` passes for *any* throw,
     * including one from an unrelated future guard — it would say "no SQL was
     * built" where it means "this guard built no SQL".
     */
    test("it never becomes a bound NULL", () => {
      let text = "";
      let message = "";
      try {
        text = pgText({ where: { metadata: { path: ["a"], equals: null } } });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/null cannot be compared through a JSON path/);
      expect(text).toBe("");
    });
  });

  /**
   * `[]` on Postgres extracts the whole document — `[].every` is vacuously
   * true, so it passed the grammar check — and `""` on SQLite raises inside
   * `json_extract` at execution time. Neither is a path.
   */
  test("an empty path is refused on both dialects", () => {
    expect(() =>
      pgText({ where: { metadata: { path: [], equals: "x" } } }),
    ).toThrow(/cannot be empty/);
    expect(() =>
      sqliteText({ where: { metadata: { path: "", equals: "x" } } }),
    ).toThrow(/cannot be empty/);
  });

  /**
   * Both extractions yield text on Postgres, so a numeric comparison has to
   * compare numbers rather than their spellings — otherwise "10" sorts before
   * "9". The cast is structural; the value is still bound.
   */
  test("a numeric comparison casts, and still binds its value", () => {
    const args = { where: { metadata: { path: ["n"], gt: 2 } } };
    expect(pgText(args)).toContain(`cast(("metadata" #>> $1) as real) > $2`);
    expect(compileRead(jsonUser, "findMany", args, postgres).bind(args)).toEqual([
      "{\"n\"}",
      2,
    ]);
  });

  /**
   * #371, the third of three, and the one that was a *choice* rather than a
   * defect. `assertPathShape` accepted `typeof part === "number"`, where
   * Prisma's generated `path` on Postgres is `string[]` — so gemi answered a
   * query the oracle could not express, which is the situation
   * `compileJsonFilter`'s docblock refuses on purpose for the SQLite operators:
   * "implementing them would make gemi answer a query the oracle cannot, which
   * is precisely where a differential test stops being able to check anything."
   *
   * Prisma's refusal is a run-time one as well as a type one. Measured on a
   * generated 6.19.2 client: `path: ["items", 0]` answers *"Argument `path`:
   * Invalid value provided. Expected String, provided Int."* before any SQL is
   * built.
   *
   * **Nothing is lost by narrowing**, which is what makes it the cheap answer:
   * `#>` takes a `text[]`, so `["items", "0"]` reaches the same array element.
   * Both spellings bind the identical path on Prisma and on gemi.
   */
  test("a path segment is a string, matching the oracle", () => {
    expect(() =>
      pgText({ where: { metadata: { path: ["items", 0], equals: "x" } } }),
    ).toThrow(/path\[1\] is a number/);
    expect(() =>
      pgText({ where: { metadata: { path: ["a", null], equals: "x" } } }),
    ).toThrow(/path\[1\] is null/);

    // Every other non-string reads grammatically too — `a ${typeof part}`
    // alone gives "a undefined" and "a object", and the number is the only
    // segment it happens to fit.
    expect(() =>
      pgText({ where: { metadata: { path: ["a", undefined], equals: "x" } } }),
    ).toThrow(/path\[1\] is undefined\./);
    expect(() =>
      pgText({ where: { metadata: { path: ["a", { b: 1 }], equals: "x" } } }),
    ).toThrow(/path\[1\] is an object\./);
    expect(() =>
      pgText({ where: { metadata: { path: ["a", ["b"]], equals: "x" } } }),
    ).toThrow(/path\[1\] is an array\./);

    // And the array-index advice is advice for *one* mistake, so it is emitted
    // for the number and withheld from the rest — a caller who wrote `null`
    // did not write an index.
    expect(() =>
      pgText({ where: { metadata: { path: ["items", 0], equals: "x" } } }),
    ).toThrow(/write \["items", "0"\] rather than \["items", 0\]/);
    expect(() =>
      pgText({ where: { metadata: { path: ["a", null], equals: "x" } } }),
    ).not.toThrow(/An array index is a key too/);

    // The string spelling reaches the element, and the bound path is identical
    // to what the numeric one used to produce — which is why this is a
    // narrowing rather than a removal.
    const args = { where: { metadata: { path: ["items", "0"], equals: "x" } } };
    expect(pgText(args)).toContain(`("metadata" #>> $1) = $2`);
    expect(compileRead(jsonUser, "findMany", args, postgres).bind(args)).toEqual([
      `{"items","0"}`,
      "x",
    ]);

    // SQLite is untouched: its grammar is a JSONPath string, where an index is
    // spelled inside the string and never reaches this check.
    expect(() =>
      sqliteText({ where: { metadata: { path: "$.items[0]", equals: "x" } } }),
    ).not.toThrow();
  });

  test("two filters on one path are ANDed", () => {
    const args = {
      where: {
        metadata: { path: "$.plan", string_starts_with: "p", not: "pro" },
      },
    };
    expect(sqliteText(args)).toContain(" and ");
  });
});
