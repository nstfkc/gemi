import { describe, expect, test } from "vitest";

import { SqliteDialect } from "../dialect/sqlite";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import { USER_COLUMNS, mapped, user } from "../fixtures";
import { compileFindMany } from "./findMany";

const sqlite = new SqliteDialect();

// The whole point of splitting compile from bind is that these tests need no
// database at all: `compile` is a pure function of the argument *shape*.
describe("compileFindMany() — sqlite", () => {
  test("emits the acceptance query exactly", () => {
    const plan = compileFindMany(
      user,
      { where: { email: "a@b.c" } },
      sqlite,
    );

    expect(plan.text).toBe(
      `select ${USER_COLUMNS} from "User" where "email" = ?`,
    );
    expect(plan.bind({ where: { email: "a@b.c" } })).toEqual(["a@b.c"]);
  });

  test("omits the where clause entirely when there is no filter", () => {
    expect(compileFindMany(user, undefined, sqlite).text).toBe(
      `select ${USER_COLUMNS} from "User"`,
    );
    expect(compileFindMany(user, {}, sqlite).text).toBe(
      `select ${USER_COLUMNS} from "User"`,
    );
    expect(compileFindMany(user, { where: {} }, sqlite).text).toBe(
      `select ${USER_COLUMNS} from "User"`,
    );
  });

  test("ANDs multiple keys, in sorted order", () => {
    const args = { where: { id: 1, email: "a@b.c" } };
    const plan = compileFindMany(user, args, sqlite);

    expect(plan.text).toBe(
      `select ${USER_COLUMNS} from "User" where "email" = ? and "id" = ?`,
    );
    // Parameters follow the placeholders, not the caller's key order.
    expect(plan.bind(args)).toEqual(["a@b.c", 1]);
  });

  // Key order is canonicalised in the plan cache key, so two argument objects
  // that differ only in key order share one cache entry — which means they must
  // also compile to the same text, or one of them gets the other's SQL.
  test("key order does not change the emitted SQL", () => {
    const a = compileFindMany(user, { where: { id: 1, email: "x" } }, sqlite);
    const b = compileFindMany(user, { where: { email: "x", id: 1 } }, sqlite);
    expect(a.text).toBe(b.text);
  });

  test("treats an explicit undefined the way Prisma does — as absent", () => {
    const args = { where: { email: undefined, id: 3 } };
    const plan = compileFindMany(user, args, sqlite);

    expect(plan.text).toBe(`select ${USER_COLUMNS} from "User" where "id" = ?`);
    expect(plan.bind(args)).toEqual([3]);
  });

  test("reads table and column names from the schema, never the field name", () => {
    const plan = compileFindMany(
      mapped,
      { where: { isArchived: true } },
      sqlite,
    );

    expect(plan.text).toBe(
      'select "id", "is_archived", "occurred_at", "payload", "size" ' +
        'from "audit_log" where "is_archived" = ?',
    );
  });

  // Never `select *`: the explicit list is what lets the shaper be built once
  // from a fixed column order.
  test("never emits select *", () => {
    expect(compileFindMany(user, {}, sqlite).text).not.toContain("*");
  });

  // Compile is a function of the shape, not the values. This is the property
  // the plan cache is built on, so it is asserted directly.
  test("the same shape with different values is byte identical", () => {
    const a = compileFindMany(user, { where: { email: "a@b.c" } }, sqlite);
    const b = compileFindMany(user, { where: { email: "zzz@qq.dev" } }, sqlite);

    expect(a.text).toBe(b.text);
    expect(a.bind({ where: { email: "a@b.c" } })).toEqual(["a@b.c"]);
    expect(b.bind({ where: { email: "zzz@qq.dev" } })).toEqual(["zzz@qq.dev"]);
  });

  // Bun's SQLite driver binds a `Date` object to NULL, which would make this
  // query return nothing at all rather than fail. The encoder is chosen at
  // compile time from the field's schema; only the value comes from the call.
  test("encodes a DateTime parameter the way Prisma stores it", () => {
    const createdAt = new Date(1772093271771);
    const args = { where: { createdAt } };
    const plan = compileFindMany(user, args, sqlite);

    expect(plan.text).toBe(
      `select ${USER_COLUMNS} from "User" where "createdAt" = ?`,
    );
    expect(plan.bind(args)).toEqual([1772093271771]);
  });

  test("encodes a Boolean parameter", () => {
    const args = { where: { isArchived: true } };
    expect(compileFindMany(mapped, args, sqlite).bind(args)).toEqual([1]);
  });

  test("never interpolates a value into the text", () => {
    const plan = compileFindMany(
      user,
      { where: { email: "'; drop table User; --" } },
      sqlite,
    );
    expect(plan.text).toBe(
      `select ${USER_COLUMNS} from "User" where "email" = ?`,
    );
    expect(plan.bind({ where: { email: "'; drop table User; --" } })).toEqual([
      "'; drop table User; --",
    ]);
  });
});

// Signatures accept the full Prisma argument type from iteration 1 and grow
// capability underneath them. That only works if the gap is loud: silently
// ignoring a `take` and returning the whole table is the worst failure this ORM
// could have.
describe("compileFindMany() — unimplemented arguments throw", () => {
  test.each([
    ["orderBy", { orderBy: { id: "asc" } }],
    ["take", { take: 10 }],
    ["skip", { skip: 5 }],
    ["select", { select: { id: true } }],
    ["include", { include: { accounts: true } }],
    ["cursor", { cursor: { id: 1 } }],
    ["distinct", { distinct: ["email"] }],
  ])("%s", (argument, args) => {
    expect(() => compileFindMany(user, args, sqlite)).toThrow(
      UnsupportedQueryError,
    );
    expect(() => compileFindMany(user, args, sqlite)).toThrow(
      `gemi ORM does not support '${argument}' yet (User.findMany).`,
    );
  });

  // Without a plain-object guard this walks the string's indices and reports
  // `does not support '0'`, which sends you looking in the wrong place.
  test("a non-object args value, without blaming a character index", () => {
    expect(() => compileFindMany(user, "x" as any, sqlite)).toThrow(
      /Expected an object/,
    );
    expect(() => compileFindMany(user, "x" as any, sqlite)).not.toThrow(/'0'/);
  });

  test("an argument explicitly set to undefined is not an error", () => {
    expect(() =>
      compileFindMany(user, { take: undefined, where: { id: 1 } }, sqlite),
    ).not.toThrow();
  });

  test.each([
    ["AND", { where: { AND: [{ id: 1 }] } }],
    ["OR", { where: { OR: [{ id: 1 }] } }],
    ["NOT", { where: { NOT: { id: 1 } } }],
  ])("the %s combinator", (argument, args) => {
    expect(() => compileFindMany(user, args, sqlite)).toThrow(
      `gemi ORM does not support '${argument}' yet (User.findMany).`,
    );
  });

  test("a where operator, named precisely", () => {
    expect(() =>
      compileFindMany(user, { where: { email: { contains: "x" } } }, sqlite),
    ).toThrow(/'where\.email\.contains'/);
  });

  test("filtering on a relation", () => {
    expect(() =>
      compileFindMany(user, { where: { accounts: { some: {} } } }, sqlite),
    ).toThrow(/'accounts'/);
  });

  // `= ?` with a null parameter matches nothing, where Prisma means `is null`.
  // Emitting the former would return the wrong rows silently.
  test("null equality, rather than emitting a predicate that matches nothing", () => {
    expect(() =>
      compileFindMany(user, { where: { deletedAt: null } }, sqlite),
    ).toThrow(/'where\.deletedAt: null'/);
  });
});

describe("compileFindMany() — unknown identifiers", () => {
  // A where key with no matching field is an error, never a passthrough: that
  // rule is what keeps user input out of the identifier positions in the SQL.
  test("a where key that is not a field throws and lists the known fields", () => {
    expect(() =>
      compileFindMany(user, { where: { "1=1; drop table User": "x" } }, sqlite),
    ).toThrow(UnknownFieldError);

    expect(() =>
      compileFindMany(user, { where: { emial: "x" } }, sqlite),
    ).toThrow(/'emial' is not a field on model User/);
  });
});
