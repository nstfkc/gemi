import { describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import {
  ParameterLimitError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "../errors";
import { USER_COLUMNS, mapped, user } from "../fixtures";
import { compileRead } from "./read";
import { compileWhere } from "./where";
import { render } from "./fragment";

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

describe("unimplemented arguments still throw", () => {
  test.each([
    ["cursor", { cursor: { id: 1 } }],
    ["distinct", { distinct: ["email"] }],
  ])("%s", (argument, args) => {
    expect(() => text(args)).toThrow(
      `gemi ORM does not support '${argument}' yet (User.findMany).`,
    );
  });

  test("a relation filter in where", () => {
    expect(() => text({ where: { accounts: { some: {} } } })).toThrow(
      /'accounts'/,
    );
  });

  test("an unknown operator, named precisely", () => {
    expect(() => text({ where: { email: { search: "x" } } })).toThrow(
      /'where\.email\.search'/,
    );
  });

  test("count rejects select rather than ignoring it", () => {
    expect(() => text({ select: { id: true } }, "count")).toThrow(
      "gemi ORM does not support 'select' yet (User.count).",
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
