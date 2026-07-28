import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createBindContext } from "./fragment";
import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import {
  MissingRequiredValueError,
  ParameterLimitError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "../errors";
import { account, bare, organization, reading, user } from "../fixtures";
import * as registry from "../registry";
import { compileWrite } from "./write";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

// The whole point of splitting compile from bind is that these tests need no
// database at all: `compile` is a pure function of the argument *shape*.
function text(op: any, args: any, dialect = sqlite) {
  return compileWrite(user, op, args, dialect).text;
}

function bind(op: any, args: any, dialect = sqlite, schema = user) {
  const plan = compileWrite(schema, op, args, dialect);
  return plan.bind(args, createBindContext());
}

describe("create", () => {
  test("column list is schema order, and every value is a parameter", () => {
    expect(text("create", { data: { email: "a@b.c", name: "A" } })).toBe(
      `insert into "User" ("publicId", "name", "email", "locale", ` +
        `"globalRole", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?, ?) ` +
        `returning "id", "publicId", "name", "email", "emailVerifiedAt", ` +
        `"verificationToken", "locale", "globalRole", "password", ` +
        `"organizationId", "createdAt", "updatedAt", "deletedAt"`,
    );
  });

  // The caller's key order must not reach the SQL, or two calls with the same
  // fields would be two plans holding identical text.
  test("caller key order does not change the statement", () => {
    expect(text("create", { data: { name: "A", email: "a@b.c" } })).toBe(
      text("create", { data: { email: "a@b.c", name: "A" } }),
    );
  });

  test("autoincrement and unset nullables are left to the database", () => {
    const columns = text("create", { data: { email: "a@b.c" } }).split(
      " values ",
    )[0];
    // `id` is @default(autoincrement()) — the database's business.
    expect(columns).not.toContain(`"id"`);
    // `deletedAt` is nullable with no default: omitted, not bound as null.
    expect(columns).not.toContain(`"deletedAt"`);
    expect(columns).not.toContain(`"name"`);
  });

  test("client-side defaults are generated, not left to the database", () => {
    const values = bind("create", { data: { email: "a@b.c" } });
    // publicId, email, locale, globalRole, createdAt, updatedAt
    const [publicId, email, locale, globalRole, createdAt, updatedAt] = values;

    expect(values).toHaveLength(6);
    expect(String(publicId)).toMatch(/^c[a-z0-9]{24}$/);
    expect(email).toBe("a@b.c");
    expect(locale).toBe("en-US");
    expect(globalRole).toBe(2);
    expect(typeof createdAt).toBe("number");
    // Prisma returns createdAt and updatedAt from one create as the same
    // instant. Reading the clock per field would not reproduce that.
    expect(createdAt).toBe(updatedAt);
  });

  test("@updatedAt is stamped on create, not only on update", () => {
    const compiled = text("create", { data: { email: "a@b.c" } });
    expect(compiled).toContain(`"updatedAt"`);
  });

  test("an explicit value beats the default", () => {
    const when = new Date("2020-01-01T00:00:00.000Z");
    const values = bind("create", {
      data: { email: "a@b.c", publicId: "fixed", createdAt: when },
    });
    expect(values).toContain("fixed");
    expect(values).toContain(when.getTime());
  });

  test("a required field with no default is refused by name", () => {
    expect(() => text("create", { data: {} })).not.toThrow();
    expect(() =>
      compileWrite(organization, "create", { data: {} }, sqlite),
    ).toThrow(MissingRequiredValueError);
  });

  test("an unknown field is an error, never a passthrough", () => {
    expect(() => text("create", { data: { nope: 1 } })).toThrow(
      UnknownFieldError,
    );
  });

  test("select narrows the returning list", () => {
    expect(
      text("create", { data: { email: "a@b.c" }, select: { id: true } }),
    ).toContain(`returning "id"`);
  });

  test("postgres numbers its placeholders", () => {
    expect(text("create", { data: { email: "a@b.c" } }, postgres)).toContain(
      `values ($1, $2, $3, $4, $5, $6)`,
    );
  });
});

describe("createMany", () => {
  test("one multi-row insert, and the count is the returned rows", () => {
    const args = { data: [{ email: "a@b.c" }, { email: "d@e.f" }] };
    expect(text("createMany", args)).toBe(
      `insert into "User" ("publicId", "email", "locale", "globalRole", ` +
        `"createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?), ` +
        `(?, ?, ?, ?, ?, ?) returning "id"`,
    );

    const plan = compileWrite(user, "createMany", args, sqlite);
    expect(plan.shape([{ id: 1 }, { id: 2 }])).toEqual({ count: 2 });
  });

  // The bug this guards is data corruption, not an error: with the column list
  // taken from row one and the values taken per row by key order, row two binds
  // its values into the wrong columns. Same types, no error, wrong data.
  test("rows written in different key orders bind to the right columns", () => {
    const args = {
      data: [
        { email: "a@b.c", name: "A" },
        { name: "B", email: "d@e.f" },
      ],
    };
    const values = bind("createMany", args);

    // Six columns per row: publicId, name, email, locale, globalRole,
    // createdAt, updatedAt — name before email, in schema order, for both rows.
    const width = values.length / 2;
    expect(values[1]).toBe("A");
    expect(values[2]).toBe("a@b.c");
    expect(values[width + 1]).toBe("B");
    expect(values[width + 2]).toBe("d@e.f");
  });

  test("rows with different key sets take the union, filling defaults", () => {
    const args = { data: [{ email: "a@b.c", name: "A" }, { email: "d@e.f" }] };
    // `name` is nullable, so the row that omits it binds null rather than
    // splitting the call into two statements.
    expect(text("createMany", args)).toContain(`"name"`);
    const values = bind("createMany", args);
    const width = values.length / 2;
    expect(values[width + 1]).toBeNull();
  });

  // A database-side default cannot be requested per row: NULL would overwrite
  // it, and SQLite rejects the DEFAULT keyword inside a VALUES list.
  test("a partially-supplied database default is refused, not guessed", () => {
    expect(() =>
      text("createMany", { data: [{ id: 1, email: "a@b.c" }, { email: "d@e.f" }] }),
    ).toThrow(/leave it to the database default/);
  });

  test("an empty list is a no-op returning count 0", () => {
    const plan = compileWrite(user, "createMany", { data: [] }, sqlite);
    expect(plan.text).toBe(`select "id" from "User" where false`);
    expect(plan.shape([])).toEqual({ count: 0 });
  });

  test("each row gets its own cuid", () => {
    const values = bind("createMany", {
      data: [{ email: "a@b.c" }, { email: "d@e.f" }],
    });
    const width = values.length / 2;
    expect(values[0]).not.toBe(values[width]);
  });

  test("nested writes are refused", () => {
    expect(() =>
      text("createMany", { data: [{ organization: { connect: { id: 1 } } }] }),
    ).toThrow(UnsupportedQueryError);
  });

  // `default values` inserts exactly one row, and there is no portable
  // multi-row spelling of it — so this used to succeed and insert one row for
  // three, reporting `{ count: 1 }`.
  test("one empty row is still `default values`", () => {
    const plan = compileWrite(bare, "createMany", { data: [{}] }, sqlite);
    expect(plan.text).toBe(`insert into "Bare" default values returning "id"`);
  });

  test("several empty rows are refused rather than silently collapsed", () => {
    expect(() =>
      compileWrite(bare, "createMany", { data: [{}, {}, {}] }, sqlite),
    ).toThrow(/All 3 rows are empty/);
  });

  // `rows × columns` is the one parameter count an application does not choose
  // by writing the query, so it is the one that can walk into a driver limit.
  test.each([
    ["sqlite", sqlite, 32766],
    ["postgres", postgres, 65535],
  ])("the %s parameter ceiling is named, not hit", (_name, dialect, limit) => {
    // Six columns per row: publicId, email, locale, globalRole, createdAt,
    // updatedAt.
    const rows = Math.ceil(limit / 6) + 1;
    const data = Array.from({ length: rows }, (_, i) => ({
      email: `a${i}@b.c`,
    }));

    expect(() => compileWrite(user, "createMany", { data }, dialect)).toThrow(
      ParameterLimitError,
    );
    expect(() => compileWrite(user, "createMany", { data }, dialect)).toThrow(
      new RegExp(`accepts at most ${limit}`),
    );
  });

  test("a createMany just under the ceiling compiles", () => {
    const data = Array.from({ length: 5461 }, (_, i) => ({
      email: `a${i}@b.c`,
    }));
    // 5461 × 6 = 32766, exactly SQLite's limit.
    expect(() =>
      compileWrite(user, "createMany", { data }, sqlite),
    ).not.toThrow();
  });
});

describe("update", () => {
  test("set clause, unique where, and returning", () => {
    expect(
      text("update", { where: { id: 1 }, data: { name: "N" } }),
    ).toContain(`update "User" set "name" = ?, "updatedAt" = ? where "id" = ?`);
  });

  test("@updatedAt is stamped even when data does not mention it", () => {
    const values = bind("update", { where: { id: 1 }, data: { name: "N" } });
    expect(values[0]).toBe("N");
    expect(typeof values[1]).toBe("number");
    expect(values[2]).toBe(1);
  });

  test("an explicit updatedAt wins", () => {
    const when = new Date("2020-01-01T00:00:00.000Z");
    const values = bind("update", {
      where: { id: 1 },
      data: { name: "N", updatedAt: when },
    });
    expect(values[1]).toBe(when.getTime());
  });

  test("a non-unique where is refused, naming the keys that would work", () => {
    expect(() => text("update", { where: { name: "x" }, data: { name: "y" } }))
      .toThrow(/needs a unique field/);
  });

  test("updateMany takes any where and returns a count", () => {
    const args = { where: { name: "x" }, data: { name: "y" } };
    expect(text("updateMany", args)).toBe(
      `update "User" set "name" = ?, "updatedAt" = ? where "name" = ? ` +
        `returning "id"`,
    );
    const plan = compileWrite(user, "updateMany", args, sqlite);
    expect(plan.shape([{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual({ count: 3 });
  });

  // There is no nested-write planner behind `updateMany` — Prisma types it as
  // unchecked input and rejects a relation key. Without this the key was
  // neither executed nor reported: `suppliedFields` skips relations silently,
  // so the `connect` simply vanished from an otherwise successful statement.
  test("a nested write in updateMany data is refused by name", () => {
    expect(() =>
      text("updateMany", {
        where: { id: 1 },
        data: { name: "x", organization: { connect: { id: 2 } } },
      }),
    ).toThrow(/updateMany cannot contain nested writes/);
  });

  // And the degenerate version, which used to report the wrong problem
  // entirely: "At least one field must be updated".
  test("updateMany data of only a relation names the relation", () => {
    expect(() =>
      text("updateMany", {
        where: { id: 1 },
        data: { organization: { connect: { id: 2 } } },
      }),
    ).toThrow(/updateMany cannot contain nested writes/);
  });

  test("update still accepts the same nested write", () => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Organization", class { static $schema = organization });
    expect(() =>
      text("update", {
        where: { id: 1 },
        data: { name: "x", organization: { connect: { id: 2 } } },
      }),
    ).not.toThrow();
    registry.clearRegistry();
  });

  test.each([
    ["increment", "+"],
    ["decrement", "-"],
    ["multiply", "*"],
    ["divide", "/"],
  ])("%s reads the column and writes it back", (operator, symbol) => {
    expect(
      text("update", {
        where: { id: 1 },
        data: { globalRole: { [operator]: 2 } },
      }),
    ).toContain(`set "globalRole" = "globalRole" ${symbol} ?`);
  });

  test("set is the explicit spelling of a plain assignment", () => {
    expect(
      text("update", { where: { id: 1 }, data: { name: { set: "N" } } }),
    ).toContain(`set "name" = ?`);
  });

  test("an empty data object is refused rather than emitting invalid SQL", () => {
    expect(() =>
      compileWrite(organization, "update", { where: { id: 1 }, data: {} }, sqlite),
    ).toThrow(/At least one field must be updated/);
  });
});

describe("delete", () => {
  test("unique where, returning the row", () => {
    expect(text("delete", { where: { id: 1 } })).toBe(
      `delete from "User" where "id" = ? returning "id", "publicId", "name", ` +
        `"email", "emailVerifiedAt", "verificationToken", "locale", ` +
        `"globalRole", "password", "organizationId", "createdAt", ` +
        `"updatedAt", "deletedAt"`,
    );
  });

  test("deleteMany takes any where and returns a count", () => {
    const plan = compileWrite(
      user,
      "deleteMany",
      { where: { name: "x" } },
      sqlite,
    );
    expect(plan.text).toBe(`delete from "User" where "name" = ? returning "id"`);
    expect(plan.shape([{ id: 1 }])).toEqual({ count: 1 });
  });

  // Prisma's deleteMany() with no where empties the table. A guard here would
  // be a divergence; it belongs in a policy (iteration 6).
  test("deleteMany with no where is allowed, matching Prisma", () => {
    expect(compileWrite(user, "deleteMany", {}, sqlite).text).toBe(
      `delete from "User" returning "id"`,
    );
  });

  test("a non-unique delete is refused", () => {
    expect(() => text("delete", { where: { name: "x" } })).toThrow(
      /needs a unique field/,
    );
  });
});

describe("upsert", () => {
  test("one statement: insert with on-conflict do update", () => {
    expect(
      text("upsert", {
        where: { email: "a@b.c" },
        create: { email: "a@b.c", name: "A" },
        update: { name: "B" },
      }),
    ).toContain(
      `on conflict ("email") do update set "name" = ?, "updatedAt" = ? ` +
        `returning "id"`,
    );
  });

  // `update: {}` is legal in Prisma and means "return the row, changed or not".
  // Organization is the model with no `@updatedAt`, so nothing else fills the
  // set clause and the self-assignment is what keeps a row coming back.
  //
  // The right-hand side names its table because inside a conflict clause
  // Postgres has both the existing row and `excluded` in scope and rejects a
  // bare column as ambiguous. Verified against a live server, not assumed.
  test("an empty update still returns the existing row", () => {
    expect(
      compileWrite(
        organization,
        "upsert",
        {
          where: { publicId: "o1" },
          create: { publicId: "o1", name: "Acme" },
          update: {},
        },
        sqlite,
      ).text,
    ).toContain(
      `on conflict ("publicId") do update set ` +
        `"publicId" = "Organization"."publicId"`,
    );
  });

  // The other half of the same ambiguity: an arithmetic update reads the column
  // it writes, so its right-hand side has to be qualified too.
  test("an arithmetic update inside a conflict clause names its table", () => {
    expect(
      text("upsert", {
        where: { email: "a@b.c" },
        create: { email: "a@b.c" },
        update: { globalRole: { increment: 1 } },
      }),
    ).toContain(`do update set "globalRole" = "User"."globalRole" + ?`);
  });

  // ...and a plain update must *not* be qualified, which is the reason the
  // qualifier is a parameter rather than always on.
  test("a plain update leaves its right-hand side unqualified", () => {
    expect(
      text("update", {
        where: { id: 1 },
        data: { globalRole: { increment: 1 } },
      }),
    ).toContain(`set "globalRole" = "globalRole" + ?`);
  });

  test("@updatedAt is stamped on the conflict branch too", () => {
    expect(
      text("upsert", {
        where: { email: "a@b.c" },
        create: { email: "a@b.c" },
        update: {},
      }),
    ).toContain(`do update set "updatedAt" = ?`);
  });

  // `on conflict` only fires when the inserted row actually collides on the
  // target, so an upsert whose `create` cannot produce that key would always
  // insert — never update. Prisma means find-then-write there, which needs a
  // transaction (iteration 5). Refused rather than silently diverging.
  /**
   * The compiler still refuses it — `on conflict` genuinely cannot express an
   * upsert whose insert can never collide on the target. What changed is that
   * `Model.$exec` diverts these calls to a read-then-write before compiling, so
   * reaching this error means somebody compiled the statement directly. The
   * message says so rather than telling an application author to restructure a
   * call that now works.
   */
  test("a create that omits the conflict key is refused by the compiler", () => {
    expect(() =>
      text("upsert", {
        where: { id: 1 },
        create: { email: "a@b.c" },
        update: { name: "N" },
      }),
    ).toThrow(/'on conflict' cannot express it/);
  });

  // Presence is a compile-time property; agreement is not, because values do
  // not exist at compile time. So this one fails at bind.
  test("a create that disagrees with the where key is refused at bind", () => {
    const args = {
      where: { email: "a@b.c" },
      create: { email: "different@b.c" },
      update: { name: "N" },
    };
    const compiled = compileWrite(user, "upsert", args, sqlite);
    expect(() => compiled.bind(args, createBindContext())).toThrow(
      /must agree on the key/,
    );
  });

  test("agreeing values bind without complaint", () => {
    const args = {
      where: { email: "a@b.c" },
      create: { email: "a@b.c" },
      update: { name: "N" },
    };
    const compiled = compileWrite(user, "upsert", args, sqlite);
    expect(() => compiled.bind(args, createBindContext())).not.toThrow();
  });

  test("a composite unique becomes a composite conflict target", () => {
    const compiled = compileWrite(
      account,
      "upsert",
      {
        where: { publicId: "p" },
        create: { publicId: "p" },
        update: { organizationRole: 1 },
      },
      sqlite,
    );
    expect(compiled.text).toContain(`on conflict ("publicId")`);
  });

  test("nested writes inside an upsert are refused", () => {
    expect(() =>
      text("upsert", {
        where: { id: 1 },
        create: { organization: { connect: { id: 1 } } },
        update: {},
      }),
    ).toThrow(/Nested writes inside an upsert/);
  });

  // `update` and `delete` honour the extra filters a Prisma 5 WhereUniqueInput
  // may carry, because their whole `where` is compiled. An `on conflict` target
  // is a key and has nowhere to put one, so compiling only the key part would
  // update a row Prisma would have left alone.
  test("a where with filters beside the unique key is refused", () => {
    expect(() =>
      text("upsert", {
        where: { email: "a@b.c", deletedAt: null },
        create: { email: "a@b.c" },
        update: { name: "N" },
      }),
    ).toThrow(/carries deletedAt beside the unique key/);
  });

  test("an explicit undefined beside the key is not a filter", () => {
    expect(() =>
      text("upsert", {
        where: { email: "a@b.c", deletedAt: undefined },
        create: { email: "a@b.c" },
        update: { name: "N" },
      }),
    ).not.toThrow();
  });

  // The conflict-key agreement check compares *encoded* values, and what
  // `encode` produces is not always a primitive: Postgres hands a `Date`
  // straight to the driver. Two Dates for one instant are never `===`, so
  // identity refused a correct call — on Postgres only, since SQLite encodes
  // the same field to a number.
  test.each([
    ["sqlite", sqlite],
    ["postgres", postgres],
  ])("a DateTime conflict key compares by value on %s", (_name, dialect) => {
    const args = {
      where: { at: new Date("2024-01-01T00:00:00Z") },
      create: { at: new Date("2024-01-01T00:00:00Z"), value: 1 },
      update: { value: 2 },
    };
    const compiled = compileWrite(reading, "upsert", args, dialect);
    expect(() => compiled.bind(args, createBindContext())).not.toThrow();
  });

  test("a DateTime conflict key that genuinely differs is still refused", () => {
    const args = {
      where: { at: new Date("2024-01-01T00:00:00Z") },
      create: { at: new Date("2024-06-01T00:00:00Z"), value: 1 },
      update: { value: 2 },
    };
    const compiled = compileWrite(reading, "upsert", args, postgres);
    expect(() => compiled.bind(args, createBindContext())).toThrow(
      /2024-01-01.*2024-06-01/s,
    );
  });

  /**
   * The refusal message has to *distinguish* the two values, or it reads as
   * "'x' is A ... but A" and looks like a framework bug rather than a wrong
   * argument. Fixing the `Date` case is easy to half-do: `String()` collapses
   * two different `Bytes` of the same length, and collapses `1n` against `1`.
   */
  test.each([
    [
      "Bytes of the same length",
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ],
    ["a bigint against a number", 1n, 1],
  ])("a mismatched %s is described distinguishably", (_label, a, b) => {
    const digest: any = {
      name: "Digest",
      table: "Digest",
      fields: {
        id: {
          name: "id",
          column: "id",
          type: "Int",
          nullable: false,
          isId: true,
          isUpdatedAt: false,
          default: { kind: "autoincrement" },
        },
        key: {
          name: "key",
          column: "key",
          type: typeof a === "bigint" ? "BigInt" : "Bytes",
          nullable: false,
          isId: false,
          isUpdatedAt: false,
        },
        note: {
          name: "note",
          column: "note",
          type: "String",
          nullable: true,
          isId: false,
          isUpdatedAt: false,
        },
      },
      primaryKey: ["id"],
      uniques: [["key"]],
      relations: {},
    };

    const args = {
      where: { key: a },
      create: { key: b },
      update: { note: "n" },
    };
    const compiled = compileWrite(digest, "upsert", args, postgres);

    let message = "";
    try {
      compiled.bind(args, createBindContext());
    } catch (error: any) {
      message = error.message;
    }

    expect(message).toMatch(/must agree on the key/);

    // The two halves of "is X in the where clause but Y in 'create'" must not
    // be the same string.
    const [, left, right] =
      /'key' is (.+?) in the where clause but (.+?) in 'create'/s.exec(
        message,
      ) ?? [];
    expect(left).toBeDefined();
    expect(left).not.toBe(right);
  });

  // Deliberate strictness, recorded in the plan's known-differences list:
  // Prisma accepts a `where` naming two unique keys, but `on conflict` takes
  // exactly one target and picking either would be silent narrowing.
  test("a where naming two different unique keys is refused", () => {
    expect(() =>
      text("upsert", {
        where: { id: 1, email: "a@b.c" },
        create: { id: 1, email: "a@b.c" },
        update: { name: "N" },
      }),
    ).toThrow(/Name exactly one unique key/);
  });
});

describe("nested writes", () => {
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Account", class { static $schema = account });
    registry.register("Organization", class { static $schema = organization });
  });

  // The registry is process-global. Vitest isolates modules per file so this
  // is invisible here, but under a shared-process runner these registrations
  // would outlive the file and break `read.test.ts`, which asserts that a
  // relation in a `select` raises when nothing is registered.
  afterEach(() => {
    registry.clearRegistry();
  });

  // The referenced value is already in hand, so this must not cost a query.
  test("connect on the referenced key is one more bound column, no step", () => {
    const args = {
      data: { email: "a@b.c", organization: { connect: { id: 7 } } },
    };
    const plan = compileWrite(user, "create", args, sqlite);

    expect(plan.before).toBeUndefined();
    expect(plan.text).toContain(`"organizationId"`);
    expect(plan.bind(args, createBindContext())).toContain(7);
  });

  // Connecting by a *different* unique needs a lookup, and that difference is a
  // property of the argument shape, so it is decided at compile time.
  test("connect by another unique plans a lookup step", () => {
    const plan = compileWrite(
      user,
      "create",
      { data: { email: "a@b.c", organization: { connect: { publicId: "p" } } } },
      sqlite,
    );
    expect(plan.before).toHaveLength(1);
    expect(plan.before?.[0].relation).toBe("organization");
  });

  test("nested create on the owning side runs before the insert", () => {
    const plan = compileWrite(
      user,
      "create",
      { data: { email: "a@b.c", organization: { create: { name: "Acme" } } } },
      sqlite,
    );
    expect(plan.before).toHaveLength(1);
    expect(plan.after).toBeUndefined();
  });

  // The child holds the key, so it cannot be written until this row exists —
  // and the key has to come back in the RETURNING list to point it at.
  test("nested create on the foreign side runs after, and returns the key", () => {
    const plan = compileWrite(
      user,
      "create",
      {
        data: { email: "a@b.c", accounts: { create: [{ organizationRole: 1 }] } },
        select: { email: true },
      },
      sqlite,
    );
    expect(plan.after).toHaveLength(1);
    expect(plan.text).toContain(`returning "id", "email"`);
    // `id` was fetched only to stitch with; the caller never asked for it.
    expect(plan.hidden).toEqual(["id"]);
  });

  test("setting a foreign key twice is refused", () => {
    expect(() =>
      text("create", {
        data: {
          email: "a@b.c",
          organizationId: 1,
          organization: { connect: { id: 2 } },
        },
      }),
    ).toThrow(/set both directly and through a nested relation write/);
  });

  test.each([
    "connectOrCreate",
    "set",
    "disconnect",
    "update",
    "upsert",
    "delete",
    "deleteMany",
    "updateMany",
  ])("%s is refused, naming itself", (operation) => {
    expect(() =>
      text("create", {
        data: { email: "a@b.c", organization: { [operation]: {} } },
      }),
    ).toThrow(new RegExp(`data\\.organization\\.${operation}`));
  });

  /**
   * The refusals now say *why*, which is the difference between "wait" and
   * "rewrite this call site". Every one of them writes rows that already exist,
   * which is the line: what is supported writes new rows or repoints a key.
   */
  test("a refusal explains what the operand would take", () => {
    expect(() =>
      text("create", {
        data: { email: "a@b.c", organization: { connectOrCreate: {} } },
      }),
    ).toThrow(/upsert against the child/);
    expect(() =>
      text("create", { data: { email: "a@b.c", accounts: { deleteMany: {} } } }),
    ).toThrow(/deletes rows this call did not name/);
  });

  /**
   * `createMany` — one statement for the children instead of one per row, which
   * is the whole reason the shape is worth having over a nested `create`.
   */
  describe("createMany", () => {
    test("plans one after step on the foreign side", () => {
      const plan = compileWrite(
        user,
        "create",
        {
          data: {
            email: "a@b.c",
            accounts: { createMany: { data: [{ organizationRole: 1 }] } },
          },
        },
        sqlite,
      );

      expect(plan.after).toHaveLength(1);
      expect(plan.after?.[0].operation).toBe("createMany");
      expect(plan.after?.[0].relation).toBe("accounts");
      // The parent's key has to come back for the children to point at.
      expect(plan.text).toContain(`returning`);
    });

    test("it is one step however many rows there are", () => {
      const plan = compileWrite(
        user,
        "create",
        {
          data: {
            email: "a@b.c",
            accounts: {
              createMany: {
                data: [
                  { organizationRole: 0 },
                  { organizationRole: 1 },
                  { organizationRole: 2 },
                ],
              },
            },
          },
        },
        sqlite,
      );

      // A nested `create` of three rows is three steps; this is the difference.
      expect(plan.after).toHaveLength(1);
    });

    test("it composes with a create on the same relation", () => {
      const plan = compileWrite(
        user,
        "create",
        {
          data: {
            email: "a@b.c",
            accounts: {
              create: [{ organizationRole: 0 }],
              createMany: { data: [{ organizationRole: 1 }] },
            },
          },
        },
        sqlite,
      );

      // Sorted, so `create` runs before `createMany` — which is the order
      // Prisma writes them in, verified by the ids it hands back.
      expect(plan.after?.map((step) => step.operation)).toEqual([
        "create",
        "createMany",
      ]);
    });

    test("update takes it too", () => {
      const plan = compileWrite(
        user,
        "update",
        {
          where: { id: 1 },
          data: { accounts: { createMany: { data: [{ organizationRole: 1 }] } } },
        },
        sqlite,
      );

      expect(plan.after).toHaveLength(1);
    });

    /**
     * The one place Prisma's nested grammar adds a level: the rows go inside
     * `data`, not directly under `createMany`. Checked at plan time so it fails
     * when the query compiles rather than after the parent row is written and
     * the transaction has to unwind it.
     */
    test.each([
      ["the rows directly", { createMany: [{ organizationRole: 1 }] }, /with a 'data' key/],
      ["no data key", { createMany: { rows: [] } }, /Expected a 'data' key/],
      ["an extra key", { createMany: { data: [], nope: 1 } }, /Expected only 'data'/],
    ])("%s is refused", (_label, node, message) => {
      expect(() =>
        text("create", { data: { email: "a@b.c", accounts: node } }),
      ).toThrow(message);
    });

    /**
     * Scoped to the *nested* form, and pointing at the spelling that works.
     * The message used to say "at any level", which stops being true once
     * top-level `skipDuplicates` lands (#69) — and a refusal that is false
     * about the rest of the API is worse than a generic one.
     */
    test("skipDuplicates names the level, and where it does work", () => {
      const refuse = () =>
        text("create", {
          data: {
            email: "a@b.c",
            accounts: { createMany: { data: [], skipDuplicates: true } },
          },
        });

      expect(refuse).toThrow(/not implemented on a \*nested\* 'createMany'/);
      expect(refuse).toThrow(/Account\.createMany/);
    });

    /**
     * A to-one holds a single foreign key, so there is nothing to create many
     * of — and a caller who reached for it has the direction of the relation
     * wrong, which is worth saying rather than answering with the grammar.
     */
    test("a to-one refuses it, from either side of the key", () => {
      expect(() =>
        text("create", {
          data: { email: "a@b.c", organization: { createMany: { data: [] } } },
        }),
      ).toThrow(/is a to-one/);

      expect(() =>
        compileWrite(
          account,
          "create",
          { data: { user: { createMany: { data: [] } } } },
          sqlite,
        ),
      ).toThrow(/is a to-one/);
    });
  });
});

describe("arguments", () => {
  test.each([
    ["create", {}, "data"],
    ["update", { data: { name: "x" } }, "where"],
    ["update", { where: { id: 1 } }, "data"],
    ["delete", {}, "where"],
    ["upsert", { where: { id: 1 }, create: {} }, "update"],
  ])("%s reports the argument it requires", (op, args, missing) => {
    expect(() => text(op, args)).toThrow(new RegExp(`requires '${missing}'`));
  });

  test("select and include together are refused", () => {
    expect(() =>
      text("create", {
        data: { email: "a@b.c" },
        select: { id: true },
        include: { accounts: true },
      }),
    ).toThrow(/only one of them/);
  });

  test("an unsupported argument names itself", () => {
    expect(() =>
      text("createMany", { data: [{ email: "a" }], skipDuplicates: true }),
    ).toThrow(/skipDuplicates/);
  });
});

// Invariant 2, asserted rather than argued: no value is ever inlined into the
// SQL text. The read suite makes the same assertion; writes are the place it is
// most tempting to break, because a column list *looks* like a good place for a
// literal.
describe("no value reaches the SQL text", () => {
  const statements = [
    text("create", { data: { email: "a@b.c", globalRole: 7 } }),
    text("createMany", { data: [{ email: "a" }, { email: "b" }] }),
    text("update", { where: { id: 42 }, data: { globalRole: { increment: 3 } } }),
    text("updateMany", { where: { globalRole: 9 }, data: { name: "x" } }),
    text("delete", { where: { id: 42 } }),
    text("deleteMany", { where: { globalRole: { in: [1, 2, 3] } } }),
    text("upsert", {
      where: { id: 5 },
      create: { id: 5, email: "a@b.c" },
      update: { globalRole: 4 },
    }),
  ];

  test.each(statements)("%s", (statement) => {
    // Identifiers are quoted, so stripping quoted spans leaves only keywords,
    // punctuation and placeholders — none of which may contain a digit.
    const withoutIdentifiers = statement.replace(/"[^"]*"/g, "");
    expect(withoutIdentifiers).not.toMatch(/\d/);
  });
});
