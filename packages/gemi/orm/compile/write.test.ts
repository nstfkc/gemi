import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createBindContext } from "./fragment";
import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import {
  InvalidArgumentError,
  MissingRequiredValueError,
  ParameterLimitError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "../errors";
import {
  account,
  bare,
  mapped,
  organization,
  post,
  profile,
  reading,
  tag,
  user,
  userWithProfile,
} from "../fixtures";
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

  /**
   * #350, at the level the bug was actually felt: `@default(nanoid())` was
   * classified `dbgenerated`, so `hasClientSideValue` said no, so the column was
   * left out of the insert — and the column Prisma's migration emits for it
   * carries no `DEFAULT`, so the driver rejected the row on NOT NULL.
   *
   * The fixtures use `cuid()`, so the field is swapped here rather than a
   * fixture changed: what is being pinned is that a `nanoid` spec reaches the
   * statement, not anything about `Account`.
   */
  test.each([
    [{ kind: "nanoid", length: 10 } as const, 10],
    // `ulid()` is the one #350's first fix missed — no `case`, so it was
    // classified `dbgenerated` and omitted exactly as `nanoid` had been.
    [{ kind: "ulid" } as const, 26],
  ])("a %s default reaches the insert", (spec, width) => {
    const withSpec = {
      ...account,
      fields: {
        ...account.fields,
        publicId: { ...account.fields.publicId, default: spec },
      },
    };

    const compiled = compileWrite(withSpec, "create", { data: {} }, sqlite);
    expect(compiled.text.split(" values ")[0]).toContain(`"publicId"`);

    // And the value is the width the schema wrote, which is the half that only
    // shows up later: an id of the wrong length is still an id.
    const values = compiled.bind({ data: {} }, createBindContext());
    expect(String(values[0])).toHaveLength(width);
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

  /**
   * `skipDuplicates` — the check and the insert in one statement, which is the
   * whole point: reading first to find out which rows exist is a second query
   * *and* a race, since a concurrent importer can write one of them in between
   * and the insert fails on a unique violation anyway.
   */
  describe("skipDuplicates", () => {
    const rows = { data: [{ email: "a@b.c" }, { email: "d@e.f" }] };

    test("true emits an untargeted conflict clause, before returning", () => {
      const emitted = text("createMany", { ...rows, skipDuplicates: true }, postgres);

      // Untargeted, so it covers every unique constraint and the primary key at
      // once — which is what `skipDuplicates` means, and what Prisma emits. A
      // targeted `on conflict (col)` would still fail on any other constraint.
      expect(emitted).toContain(` on conflict do nothing returning "id"`);
    });

    test("false is the same statement as not asking", () => {
      expect(text("createMany", { ...rows, skipDuplicates: false }, postgres)).toBe(
        text("createMany", rows, postgres),
      );
    });

    /**
     * The count has to be the number *inserted*, not the number supplied —
     * the part the issue flags as most likely to be got wrong. It falls out:
     * a row a conflict skipped never reaches `RETURNING`.
     */
    test("the count is what was inserted, not what was offered", () => {
      const plan = compileWrite(
        user,
        "createMany",
        { ...rows, skipDuplicates: true },
        postgres,
      );

      expect(plan.shape([{ id: 1 }])).toEqual({ count: 1 });
      expect(plan.shape([])).toEqual({ count: 0 });
    });

    /**
     * SQLite *can* express it, and Prisma still rejects the argument there —
     * for `false` as well as `true`, verified against a generated 6.19 client.
     * Accepting `false` because it happens to be a no-op would make the two
     * dialects disagree about which calls are legal.
     */
    test.each([true, false])("%s is refused on sqlite, naming the dialect", (value) => {
      expect(() =>
        text("createMany", { ...rows, skipDuplicates: value }),
      ).toThrow(/not available on sqlite/);
      expect(() =>
        text("createMany", { ...rows, skipDuplicates: value }),
      ).toThrow(/Prisma does not offer it there either/);
    });

    /**
     * Validation must not depend on how much data happened to be supplied. The
     * empty-list shortcut returns before the statement is built, so the check
     * has to come first or `createMany({ data: [], skipDuplicates: true })`
     * succeeds on SQLite and the same call with one row throws.
     */
    test("an empty list is validated too", () => {
      expect(() =>
        text("createMany", { data: [], skipDuplicates: true }),
      ).toThrow(/not available on sqlite/);
      expect(() =>
        compileWrite(user, "createMany", { data: [], skipDuplicates: true }, postgres),
      ).not.toThrow();
    });

    test("a non-boolean is refused", () => {
      expect(() =>
        compileWrite(user, "createMany", { ...rows, skipDuplicates: "yes" }, postgres),
      ).toThrow(/Expected true or false/);
    });

    test("it is only an argument of createMany", () => {
      expect(() =>
        compileWrite(
          user,
          "create",
          { data: { email: "a@b.c" }, skipDuplicates: true },
          postgres,
        ),
      ).toThrow(UnsupportedQueryError);
    });
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

  /**
   * #355. An empty `data` used to be refused here — "At least one field must be
   * updated" — on the reasoning that there is nothing to do. Prisma disagrees:
   * measured on 6.19.2/SQLite, `update({ where: { id: 1 }, data: {} })` returns
   * the row unchanged, honours `include` and `select` while doing it, and still
   * raises P2025 when the `where` matches nothing.
   *
   * **Every test below uses `organization`, and that is not incidental.**
   * `updateAssignments` stamps `@updatedAt` unconditionally, so a model
   * carrying one *always* has an assignment and can never reach this branch or
   * the relation-only one — `user` would compile a real `UPDATE` here and prove
   * nothing. `organization` has no `@updatedAt`. The last test in this block
   * pins that difference so the choice of fixture stays legible.
   */
  describe("an empty data reads the row rather than writing it", () => {
    const empty = (args: any, schema = organization) =>
      compileWrite(schema, "update", { where: { id: 1 }, ...args }, sqlite);

    test("it selects instead of emitting an UPDATE with no assignments", () => {
      const plan = empty({ data: {} });
      expect(plan.text).toBe(
        `select "id", "publicId", "name", "logoUrl", "description" ` +
          `from "Organization" where "id" = ?`,
      );
      expect(plan.text).not.toContain("update");
    });

    /**
     * The invariant #355's acceptance rests on: the empty `data` is not a new
     * code path, it is the *existing* relation-only one with its guard removed.
     * If these two ever stop agreeing, something has grown a second way to read
     * a row on the write path — which is how the `include` and `_count` cases
     * below would start diverging silently.
     */
    test("it is byte-identical to a data of only nested writes", () => {
      registry.clearRegistry();
      registry.register("User", class { static $schema = user });
      registry.register("Organization", class { static $schema = organization });

      const relationOnly = empty({ data: { users: { connect: { id: 2 } } } });
      expect(empty({ data: {} }).text).toBe(relationOnly.text);
      // …and the nested step is still planned, so the agreement is about the
      // statement rather than about both of them doing nothing.
      expect(relationOnly.after).toHaveLength(1);

      registry.clearRegistry();
    });

    // Measured: `post.update({ where, data: {} , include: { tags: true } })`
    // comes back with the tags. It goes through the same `plan()` call as every
    // other update, so this needs no clause of its own — but a bare row fetch
    // that ignored `include` would pass every other test in this block.
    test("include is honoured", () => {
      registry.clearRegistry();
      registry.register("User", class { static $schema = user });
      registry.register("Organization", class { static $schema = organization });

      const plan = empty({ data: {}, include: { users: true } });
      expect(plan.relations).toHaveLength(1);
      expect(plan.relations![0]).toMatchObject({ as: "users", kind: "many" });

      registry.clearRegistry();
    });

    // Measured: `select: { title: true }` returns `{ title: "p1" }` with no
    // `id`, exactly as it narrows a normal update.
    test("select narrows the read", () => {
      expect(empty({ data: {}, select: { name: true } }).text).toBe(
        `select "name" from "Organization" where "id" = ?`,
      );
    });

    // The `where` is still the caller's, so a miss returns no row — and
    // `update` is in ORTHROW, where `$exec` turns that into
    // `RecordNotFoundError`, Prisma's P2025 for the same call.
    test("a miss shapes to null, which is what ORTHROW raises on", () => {
      expect(empty({ data: {} }).shape([])).toBeNull();
    });

    // Not a divergence to fix: Prisma's client rejects this before the query
    // engine sees it. The point is that it must not fall into the branch above
    // and answer a malformed call with a row.
    test("a null data is still refused, and says what a good one looks like", () => {
      expect(() => empty({ data: null })).toThrow(InvalidArgumentError);
      expect(() => empty({ data: null })).toThrow(/like \{ name: 'new name' \}/);
    });

    // `@updatedAt` does not keep a model out of this branch, and the fact that
    // it used to is the reason #355 shipped half-finished the first time: the
    // stamp was the assignment that kept the count off zero, so the read was
    // dead on every model carrying the attribute — which is most of them, and
    // is the one the issue was filed from.
    //
    // MEASURED (Prisma 6.19.2, SQLite), seeding `updatedAt` to the epoch and
    // reading it back: `user.update({ where, data: {} })` leaves it at 0. So
    // Prisma does not stamp a call that sets no column, and the same select is
    // right here as on a model without one. See `updateAssignments`.
    test("a model with @updatedAt reads too, and does not stamp", () => {
      const plan = compileWrite(user, "update", { where: { id: 1 }, data: {} }, sqlite);
      expect(plan.text).toBe(
        `select "id", "publicId", "name", "email", "emailVerifiedAt", ` +
          `"verificationToken", "locale", "globalRole", "password", ` +
          `"organizationId", "createdAt", "updatedAt", "deletedAt" ` +
          `from "User" where "id" = ?`,
      );
    });

    // The other half of the same rule, so the fix cannot be read as "never
    // stamp": one real column brings the stamp back. Measured alongside —
    // `data: { name: "real" }` does move `updatedAt`.
    test("one supplied column brings the stamp back", () => {
      const plan = compileWrite(
        user,
        "update",
        { where: { id: 1 }, data: { name: "real" } },
        sqlite,
      );
      expect(plan.text).toContain(`set "name" = ?, "updatedAt" = ?`);
    });
  });

  /**
   * MEASURED (Prisma 6.19.2, SQLite): `updateMany({ where, data: {} })` answers
   * `{ count: 0 }` — with two of three rows matching the filter, with a filter
   * matching none, and with no `where` at all. The count is a constant, not a
   * row count, and no row is touched.
   *
   * So this is `createMany([])`'s plan, and these assert it is *literally* that
   * plan: the same constant-false select, so nothing is read and the filter is
   * never evaluated.
   */
  describe("an empty data in updateMany counts zero", () => {
    const many = (args: any) =>
      compileWrite(organization, "updateMany", { data: {}, ...args }, sqlite);

    test("it is the constant-zero plan, whatever the filter", () => {
      const expected = `select "id" from "Organization" where false`;
      expect(many({ where: { name: "x" } }).text).toBe(expected);
      expect(many({ where: { name: "nope" } }).text).toBe(expected);
      expect(many({}).text).toBe(expected);
      expect(many({ where: { name: "x" } }).shape([])).toEqual({ count: 0 });
    });

    // The filter is discarded, not skipped: an unknown field is refused whether
    // or not there was anything to write, for the reason `createMany` validates
    // `skipDuplicates` ahead of its own empty-list shortcut.
    test("the discarded where is still validated", () => {
      expect(() => many({ where: { nosuchfield: 1 } })).toThrow(UnknownFieldError);
    });

    // A model with `@updatedAt` takes the same branch, exactly as on `update`.
    // MEASURED: `user.updateMany({ where: { name: "n" }, data: {} })` answers
    // `{ count: 0 }` against a matching row and leaves `updatedAt` at the epoch
    // — so the constant is Prisma's answer here too, and the stamp that used to
    // make this model write was a divergence rather than the attribute working.
    test("a model with @updatedAt counts zero too, and does not stamp", () => {
      const plan = compileWrite(user, "updateMany", { where: { name: "x" }, data: {} }, sqlite);
      expect(plan.text).toBe(`select "id" from "User" where false`);
      expect(plan.shape([])).toEqual({ count: 0 });
    });
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
  /**
   * A one-field unique whose key type varies — the shape the conflict-key
   * agreement tests below need. They differ only in that type, so this is a
   * factory rather than a fixture copied per test.
   */
  const digestSchema = (keyType: string): any => ({
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
        type: keyType,
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
  });

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

  /**
   * The conflict branch follows the same rule as an ordinary update: a column
   * beside the stamp, or no stamp. MEASURED (Prisma 6.19.2, SQLite), seeding
   * `updatedAt` to the epoch:
   *
   *     upsert hit, update: {}              epoch   not stamped
   *     upsert hit, update: { name: "x" }   now     stamped
   *
   * This test used to assert the first case stamped, which was gemi's answer
   * and not Prisma's. `do update set "email" = "User"."email"` is the no-op
   * self-assignment the compiler already emits to keep `on conflict do update`
   * valid SQL with nothing to set, so the branch still fires and still returns
   * the row — it simply writes no column, which is what was asked.
   */
  test("@updatedAt follows the column on the conflict branch too", () => {
    expect(
      text("upsert", {
        where: { email: "a@b.c" },
        create: { email: "a@b.c" },
        update: {},
      }),
    ).not.toContain(`"updatedAt" = ?`);

    expect(
      text("upsert", {
        where: { email: "a@b.c" },
        create: { email: "a@b.c" },
        update: { name: "x" },
      }),
    ).toContain(`do update set "name" = ?, "updatedAt" = ?`);
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

  /**
   * The same for `Bytes`, which is the other type `encode` hands over as an
   * object and the other half of why `sameEncoded` is not `===`.
   *
   * Its doc gives both: "Postgres passes a `DateTime` through as the `Date` it
   * was given, and **both dialects** pass `Bytes` through as a `Uint8Array` —
   * so the same instant and the same bytes arrive here as two distinct objects,
   * and identity refuses a correct upsert".
   *
   * `DateTime` had a test in each direction. `Bytes` had only the refusal —
   * that a *mismatched* pair is described distinguishably — so the branch that
   * makes a *matching* pair work was never exercised. Mutation found it:
   * inverting the length check inside that branch makes every equal pair
   * compare unequal, and nothing failed.
   *
   * Both dialects, unlike the `Date` case which is Postgres-only: SQLite
   * encodes a `DateTime` to a number and never reaches this, but it passes
   * `Bytes` through as an object exactly as Postgres does.
   */
  test.each([
    ["sqlite", sqlite],
    ["postgres", postgres],
  ])("a Bytes conflict key compares by value on %s", (_name, dialect) => {
    const digest = digestSchema("Bytes");

    // Equal bytes, two distinct objects — which is how they arrive from a
    // caller who built the `where` and the `create` separately.
    const args = {
      where: { key: new Uint8Array([1, 2, 3]) },
      create: { key: new Uint8Array([1, 2, 3]) },
      update: { note: "n" },
    };

    const compiled = compileWrite(digest, "upsert", args, dialect);

    // Binding the values is the assertion: it does not throw, *and* the bytes
    // survive the check into the parameter list rather than being dropped or
    // replaced by whatever the agreement check compared.
    const values = compiled.bind(args, createBindContext());
    expect(values).toContainEqual(new Uint8Array([1, 2, 3]));
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
   *
   * The last row is also what holds `sameEncoded`'s two-sided view test to
   * `&&`. The `where` value and the `create` value are supplied independently
   * and neither is type-checked before it arrives, so a mixed pair — one view,
   * one not — is reachable, exactly as the `1n`/`1` row is. Under `||` the
   * non-view side is rebuilt as `new Uint8Array(undefined, undefined,
   * undefined)`, which is empty, and an empty `Bytes` key would then match a
   * wrong-typed `create` and be silently accepted on a write.
   */
  test.each([
    [
      "Bytes of the same length",
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      "Bytes",
    ],
    ["a bigint against a number", 1n, 1, "BigInt"],
    ["an empty Bytes against a string", new Uint8Array([]), "abc", "Bytes"],
  ])(
    "a mismatched %s is described distinguishably",
    (_label, a, b, keyType) => {
      const digest = digestSchema(keyType as string);

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

      // The two halves of "is X in the where clause but Y in 'create'" must
      // not be the same string.
      const [, left, right] =
        /'key' is (.+?) in the where clause but (.+?) in 'create'/s.exec(
          message,
        ) ?? [];
      expect(left).toBeDefined();
      expect(left).not.toBe(right);
    },
  );

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
    // The implicit many-to-many pair, for the two-operand-set reconciliation.
    registry.register("Post", class { static $schema = post });
    registry.register("Tag", class { static $schema = tag });
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

  test.each(["disconnect", "update", "upsert", "delete"])(
    "%s is refused on a create, naming itself",
    (operation) => {
      expect(() =>
        text("create", {
          data: { email: "a@b.c", organization: { [operation]: {} } },
        }),
      ).toThrow(new RegExp(`data\\.organization\\.${operation}`));
    },
  );

  /**
   * `REFUSED` is empty now: every entry it held described machinery that
   * turned out to exist one layer down. What still refuses on a `create` is the
   * *statement*, not the operand — a row that does not exist yet has nothing
   * linked to it, and Prisma reports these as unknown arguments there too.
   */
  test("an operand that needs an existing row says so on a create", () => {
    for (const operand of ["upsert", "deleteMany", "disconnect", "update"]) {
      expect(() =>
        text("create", { data: { email: "a@b.c", accounts: { [operand]: {} } } }),
      ).toThrow(/has none yet/);
    }
  });

  /**
   * A refusal's **structured fields**, which are the part an application can
   * act on — and were the part that was wrong (#108).
   *
   * `UnsupportedQueryError` documents `model`, `operation` and `argument` as
   * inspectable. A nested unique-key refusal reported the *child's* model and a
   * synthesized `update.accounts.disconnect` as the operation — a string that
   * is not one of the thirteen, so anything branching on it could never match.
   *
   * Asserted on the fields rather than the message, because the message is
   * allowed to change and these are not. The child still has to appear *in* the
   * message, since it is whose keys are being listed.
   */
  describe("a refusal names the caller's query, not the child's", () => {
    const caught = (data: unknown) => {
      try {
        compileWrite(user, "update", { where: { id: 1 }, data } as never, sqlite);
        return null;
      } catch (error) {
        return error as UnsupportedQueryError;
      }
    };

    test.each([
      ["disconnect", { accounts: { disconnect: { nope: 1 } } }],
      ["delete", { accounts: { delete: { nope: 1 } } }],
      ["update", { accounts: { update: { where: { nope: 1 }, data: {} } } }],
      ["upsert", { accounts: { upsert: { where: { nope: 1 }, create: {}, update: {} } } }],
      ["connectOrCreate", { accounts: { connectOrCreate: { where: { nope: 1 }, create: {} } } }],
      // `connect` on the foreign side is absent deliberately: it validates its
      // key inside the `after` step rather than at plan time, so it does not
      // refuse during compile at all. Its origin triple is converted with the
      // rest, but the refusal arrives later — which is its own inconsistency
      // with this file's "checked at plan time" rule, and not #108's.
    ])("%s reports User.update and the operand path", (operand, data) => {
      const error = caught(data);
      expect(error).not.toBeNull();

      // The caller's query, not the child's.
      expect(error!.model).toBe("User");
      expect(error!.operation).toBe("update");
      expect(error!.argument).toContain(`data.accounts.${operand}`);

      // ...and the child is still named, because these are its keys.
      expect(error!.message).toContain("Account");
    });

    /** A root-level refusal is unchanged: there the caller's model *is* this one. */
    test("a root unique-key refusal still reports itself", () => {
      try {
        compileWrite(user, "delete", { where: { nope: 1 } } as never, sqlite);
        throw new Error("expected a refusal");
      } catch (error) {
        const refusal = error as UnsupportedQueryError;
        expect(refusal.model).toBe("User");
        expect(refusal.operation).toBe("delete");
        expect(refusal.argument).toBe("where");
      }
    });
  });

  /**
   * **Both sides of a to-one answer the same way**, which they did not.
   *
   * `planForeignSide` had exactly one `relation.kind` check — `createMany`'s —
   * because no fixture had a to-one whose foreign key is on the child, so
   * nothing ever reached it with `kind: "one"` (#116). Everything else planned
   * the child as a list: `updateMany` and `deleteMany` **compiled**, and
   * `update` / `delete` / `upsert` were refused for not looking like the
   * to-many spelling rather than for being unimplemented on this shape.
   *
   * Prisma's to-one nested input, read off the generated client:
   *
   *     { create, connectOrCreate, upsert, disconnect, delete, connect, update }
   *
   * — no `createMany`, `set`, `updateMany` or `deleteMany` key at all.
   *
   * Walked as a table over both sides, because the two disagreeing *is* the
   * defect and a one-sided test cannot see it.
   *
   * **The three refusals this describe used to pin have inverted**: `update`,
   * `delete` and `upsert` compile on the foreign side now. What is left is a
   * genuine asymmetry — `delete` and `upsert` are still refused *by name* on
   * the owning side, each for a reason of its own — and it is asserted below
   * rather than left implicit. An unasserted asymmetry in a describe titled
   * "answers the same on both sides" is exactly how #116 happened: the sentence
   * reads like a guarantee and nothing was checking the half it did not cover.
   */
  describe("a to-one answers the same on both sides", () => {
    beforeEach(() => {
      registry.register("Profile", class { static $schema = profile });
      registry.register("User", class { static $schema = userWithProfile });
    });

    const write = (
      relation: string,
      operand: Record<string, unknown>,
      schema: typeof user = userWithProfile,
    ) =>
      compileWrite(
        schema,
        "update",
        { where: { id: 1 }, data: { [relation]: operand } } as never,
        sqlite,
      );

    const refuse = (
      relation: string,
      operand: Record<string, unknown>,
      schema: typeof user = userWithProfile,
    ) => {
      try {
        write(relation, operand, schema);
        return null;
      } catch (error) {
        return error as UnsupportedQueryError;
      }
    };

    /**
     * The four keys Prisma's to-one input does not have. Refused by name on
     * both sides, with the same reason — `createMany` already was, the other
     * three were the gap.
     */
    test.each([
      ["set", { set: [{ id: 1 }] }],
      ["updateMany", { updateMany: { where: {}, data: {} } }],
      ["deleteMany", { deleteMany: {} }],
      ["createMany", { createMany: { data: [{}] } }],
    ])("%s is refused on both sides", (operand, value) => {
      // `organization` — this row holds the key. `profile` — the child does.
      for (const relation of ["organization", "profile"]) {
        const error = refuse(relation, value);
        expect(error, `${relation}.${operand} compiled`).not.toBeNull();
        expect(error!.argument).toBe(`data.${relation}.${operand}`);
        expect(error!.model).toBe("User");
        expect(error!.message).toMatch(/is a to-one/);
      }
    });

    /**
     * The three that *are* on Prisma's to-one input, and now compile on the
     * side whose child holds the key.
     *
     * Each is one `after` step labelled with the operand it implements — the
     * plan is what a later reader has to be able to trust, and a step labelled
     * `connect` for a `delete` is how the fall-through bugs above went unseen.
     */
    test.each([
      ["update", { update: { bio: "y" } }],
      ["delete", { delete: true }],
      ["upsert", { upsert: { create: {}, update: {} } }],
    ])("%s compiles on the foreign side, as one labelled step", (operand, value) => {
      const plan = write("profile", value);

      expect(plan.after).toHaveLength(1);
      expect(plan.after![0].relation).toBe("profile");
      expect(plan.after![0].operation).toBe(operand);

      // The child is reached after this row exists, so its key has to come
      // back — and it does, whichever statement carries it. Both spellings are
      // asserted rather than one, because which one this compiles to depends on
      // something the operand does not say: a relation-only `data` writes no
      // column of *this* row, so `User` reads (`select "id", …`) while a model
      // whose `data` also set a scalar would write (`update … returning "id"`).
      // Prisma agrees that nothing is written here — measured, it leaves
      // `updatedAt` at the epoch for exactly these three calls — so the select
      // is the match rather than a shortcut. See `updateAssignments`.
      expect(plan.text).toMatch(/^(?:select|update .* returning) "id",/);
    });

    /**
     * **The asymmetry that remains, asserted rather than implied.**
     *
     * Neither of these is the shape gap #116 was about; both are decisions with
     * their own reasons, written at their refusal sites. `delete` through a key
     * on *this* row would remove a row the statement is not about; `upsert`
     * there would have to create the far row and then write back to a parent
     * that has already been inserted.
     *
     * `update` is deliberately absent from this table: it works on both sides,
     * which is what makes the two above a real difference rather than a general
     * one.
     */
    test.each([
      ["delete", { delete: true }, /would remove a row this statement is not about/],
      ["upsert", { upsert: { create: {}, update: {} } }, /already been inserted/],
    ])("%s stays refused by name on the owning side", (operand, value, why) => {
      const error = refuse("organization", value);

      expect(error, `organization.${operand} compiled`).not.toBeNull();
      expect(error!.argument).toBe(`data.organization.${operand}`);
      expect(error!.model).toBe("User");
      expect(error!.message).toMatch(why);

      // ...and the same operand on the other side does not refuse, which is
      // what makes this an asymmetry rather than a shared refusal.
      expect(refuse("profile", value)).toBeNull();
    });

    test("update is the one of the three that works on both sides", () => {
      expect(refuse("organization", { update: { name: "n" } })).toBeNull();
      expect(refuse("profile", { update: { bio: "b" } })).toBeNull();
    });

    // The operands that work on this shape, so the refusals above are not
    // simply "everything fails".
    test.each([
      ["create", { create: { bio: "x" } }],
      ["connect", { connect: { userId: 1 } }],
      ["connectOrCreate", { connectOrCreate: { where: { userId: 1 }, create: { bio: "x" } } }],
    ])("%s still compiles on the foreign side", (_operand, value) => {
      expect(refuse("profile", value)).toBeNull();
    });

    /**
     * **The spellings, which are the whole of what #354 was.** Prisma's to-one
     * input is a different grammar from its to-many one, so each of these is a
     * legal query that used to be refused for looking wrong:
     *
     *   - `update` takes its data bare *and* wrapped, and both mean the same
     *     write — measured on this side, not inherited from the owning side's
     *     measurement.
     *   - the `where` is optional on `update` and on `upsert`, and it is a
     *     **filter**: `{ bio: … }` has no unique index behind it and Prisma
     *     accepts it. A `matchUniqueKey` on this path would refuse it.
     *   - `delete` takes a boolean or a filter.
     */
    test.each([
      ["update, bare data", { update: { bio: "y" } }],
      ["update, wrapped in data", { update: { data: { bio: "y" } } }],
      ["update, with a non-unique filter", { update: { where: { bio: "old" }, data: { bio: "y" } } }],
      ["delete: true", { delete: true }],
      ["delete: false", { delete: false }],
      ["delete by filter", { delete: { bio: "old" } }],
      ["upsert without a where", { upsert: { create: { bio: "x" }, update: { bio: "y" } } }],
      ["upsert with a non-unique where", { upsert: { where: { bio: "old" }, create: { bio: "x" }, update: { bio: "y" } } }],
    ])("%s compiles on a to-one", (_label, value) => {
      expect(refuse("profile", value)).toBeNull();
    });

    /**
     * `delete: false` is a call that asks for nothing, and it has to compile —
     * refusing it would be stricter than Prisma, which accepts it and leaves
     * the child untouched, foreign key included.
     *
     * It still plans a step. That is deliberate and it is what makes the design
     * safe: the step reads the boolean out of the *call* at bind time, so the
     * emptiness is decided per execution rather than baked into a plan that a
     * later call with the other boolean could be served. See `toOneOperand`.
     */
    test("delete: false plans a step that reads the boolean at bind time", () => {
      const plan = write("profile", { delete: false });
      expect(plan.after).toHaveLength(1);
      expect(plan.after![0].operation).toBe("delete");
    });

    /**
     * **Arrays on a to-one**, which compiled and wrote through a relation that
     * holds one row: `create: [a, b]` inserted two children and
     * `connect: [x, y]` repointed both. Prisma refuses every one of these as a
     * validation error on the argument, so gemi refusing them is agreement
     * rather than strictness — and the error class says which: a supported
     * argument with a bad value.
     */
    test.each([
      ["create", { create: [{ bio: "a" }, { bio: "b" }] }],
      ["connect", { connect: [{ userId: 1 }, { userId: 2 }] }],
      ["connectOrCreate", { connectOrCreate: [{ where: { userId: 1 }, create: { bio: "a" } }] }],
      ["update", { update: [{ where: { userId: 1 }, data: { bio: "a" } }] }],
      ["delete", { delete: [{ bio: "a" }] }],
      ["upsert", { upsert: [{ create: { bio: "a" }, update: { bio: "b" } }] }],
    ])("an array of %s is refused on a to-one", (operand, value) => {
      const error = refuse("profile", value);

      expect(error, `an array of ${operand} compiled`).not.toBeNull();
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(error!.argument).toBe(`data.profile.${operand}`);
      expect(error!.model).toBe("User");
      // The message names the shape that works, rather than saying arrays are
      // unimplemented — they are refused, not missing.
      expect(error!.message).toMatch(/Expected a single object/);
      // ...and it names the side that actually holds the key.
      expect(error!.message).toContain("Profile holds the foreign key");
    });

    // The same operands, singular, are the compiling cases above — asserted
    // here too so the table cannot pass by refusing everything.
    test("...while the same operands compile as a single object", () => {
      expect(refuse("profile", { create: { bio: "a" } })).toBeNull();
      expect(refuse("profile", { connect: { userId: 1 } })).toBeNull();
    });

    /**
     * `disconnect` needs a **nullable** foreign key, and the shared fixture's
     * is required on purpose — that pairing is what makes the relation a to-one
     * in Prisma's own terms. So the clone is built here rather than in
     * `fixtures.ts`, following `strictAccount` below: four suites compare the
     * fixtures wholesale, and a churned fixture is a diff in all of them.
     */
    describe("disconnect, where the child's key is nullable", () => {
      const nullableProfile = {
        ...profile,
        fields: {
          ...profile.fields,
          userId: { ...profile.fields.userId, nullable: true },
        },
        relations: {
          ...profile.relations,
          user: { ...profile.relations.user, nullable: true },
        },
      } as typeof profile;

      beforeEach(() => {
        registry.register("Profile", class { static $schema = nullableProfile });
      });

      test.each([
        ["disconnect: true", { disconnect: true }],
        ["disconnect: false", { disconnect: false }],
        ["disconnect by filter", { disconnect: { bio: "old" } }],
      ])("%s compiles", (_label, value) => {
        const plan = write("profile", value);
        expect(plan.after).toHaveLength(1);
        expect(plan.after![0].operation).toBe("disconnect");
      });

      // A filter, not a unique key — the same operand Prisma types as
      // `ProfileWhereInput | boolean`. `bio` has no unique index, and
      // `assertNamedRows` would have listed the ones it does have.
      test("a non-unique filter is not refused", () => {
        expect(refuse("profile", { disconnect: { bio: "old" } })).toBeNull();
      });

      test.each([
        ["disconnect", { disconnect: 5 }],
        ["delete", { delete: 5 }],
      ])("%s of the wrong type says what a good value is", (operand, value) => {
        const error = refuse("profile", value as Record<string, unknown>);

        expect(error).toBeInstanceOf(InvalidArgumentError);
        expect(error!.argument).toBe(`data.profile.${operand}`);
        expect(error!.message).toMatch(/takes either a boolean/);
        expect(error!.message).toContain("ProfileWhereInput | boolean");
      });
    });

    /**
     * ...and with the *required* key the shared fixture has, `disconnect` is
     * still refused — on the **key**, not the value, which is why even
     * `disconnect: false` is refused rather than quietly accepted as a no-op.
     * Prisma leaves the field out of the input type entirely on a required
     * relation, so both spellings are unknown arguments there.
     */
    test.each([[true], [false], [{ bio: "old" }]])(
      "disconnect: %s is refused when the child's key is required",
      (value) => {
        const error = refuse("profile", { disconnect: value });

        expect(error).not.toBeNull();
        expect(error!.argument).toBe("data.profile.disconnect");
        expect(error!.message).toContain("'Profile.userId' is required");
      },
    );
  });

  /**
   * **`disconnect` on a required relation reports the caller's model, and says
   * whose column is required.**
   *
   * `assertDisconnectable` has three call sites and they disagreed about what
   * its first parameter meant. The owning side passed the caller's schema; the
   * two foreign-side sites passed the *child*, whose name then landed in the
   * structured `model` field. So `User.update` refused with `model = "Account"`
   * from one branch and `model = "User"` from another, out of one function
   * (#112).
   *
   * **It had no test at all** — nothing in the repo matched its message, which
   * is how two of three sites stayed wrong. The fixtures could not reach it
   * either: none has a required foreign key on a to-many child, so the clones
   * below make one. That absence is the whole reason this needs saying.
   *
   * The two things the function needs are now separate parameters, because they
   * are separate questions: the column's owner (for the message) and the caller
   * (for the fields).
   */
  describe("disconnect on a required relation", () => {
    // `Account.userId` required — the child holds the key, so the foreign-side
    // branches are reachable.
    const strictAccount = {
      ...account,
      fields: {
        ...account.fields,
        userId: { ...account.fields.userId, nullable: false },
      },
    } as typeof account;

    // `User.organizationId` required — this row holds the key, for the owning
    // side.
    const strictUser = {
      ...user,
      fields: {
        ...user.fields,
        organizationId: { ...user.fields.organizationId, nullable: false },
      },
    } as typeof user;

    const refuse = (schema: typeof user, data: unknown) => {
      try {
        compileWrite(schema, "update", { where: { id: 1 }, data } as never, sqlite);
        return null;
      } catch (error) {
        return error as UnsupportedQueryError;
      }
    };

    describe("the child holds the key", () => {
      beforeEach(() => {
        registry.clearRegistry();
        registry.register("User", class { static $schema = user });
        registry.register("Account", class { static $schema = strictAccount });
        registry.register("Organization", class { static $schema = organization });
      });

      test.each([
        ["disconnect", { accounts: { disconnect: { id: 1 } } }],
        ["set", { accounts: { set: [{ id: 1 }] } }],
      ])("%s reports User, and names Account's column", (operand, data) => {
        const error = refuse(user, data);
        expect(error).not.toBeNull();

        // The caller's query — this was `Account` before.
        expect(error!.model).toBe("User");
        expect(error!.operation).toBe("update");
        expect(error!.argument).toBe(`data.accounts.${operand}`);

        // ...and the column is qualified, since it is not on the model above.
        expect(error!.message).toContain("'Account.userId' is required");
      });
    });

    describe("this row holds the key", () => {
      beforeEach(() => {
        registry.clearRegistry();
        registry.register("User", class { static $schema = strictUser });
        registry.register("Account", class { static $schema = account });
        registry.register("Organization", class { static $schema = organization });
      });

      // The site that was already right. Kept so the two cannot drift apart
      // again without a test noticing — the divergence was the defect.
      test("disconnect reports User, and names User's own column", () => {
        const error = refuse(strictUser, { organization: { disconnect: true } });
        expect(error).not.toBeNull();
        expect(error!.model).toBe("User");
        expect(error!.operation).toBe("update");
        expect(error!.argument).toBe("data.organization.disconnect");
        expect(error!.message).toContain("'User.organizationId' is required");
      });
    });
  });

  /**
   * **A key the child does not declare is refused by the compiler, on every
   * path that names a row by one.**
   *
   * `assertNamedRows` states the rule: "Validated at plan time for the reason
   * every operand here is: a refusal that arrives mid-transaction has to unwind
   * a parent row that should never have been written."
   *
   * Three sites did not follow it — foreign-side `connect`, and join-table
   * `connect`/`disconnect`/`set` — so the *same* operand was checked by the
   * compiler on an ordinary relation and from inside a nested step through a
   * join table, and `connect` was checked at plan time on the owning side and
   * at run time on the foreign one. Nothing distinguished those cases; it was
   * an omission (#110).
   *
   * Walked as a table rather than tested one deep, because the per-path tables
   * are what turned "one omission" into three. Plan-time checking is sound here
   * because the plan key carries the operand's key *names* and collapses only
   * its values — `{ id: 1 }` and `{ id: 999 }` share a plan, `{ id: 1 }` and
   * `{ nope: 1 }` do not.
   */
  describe("an undeclared unique key is refused by the compiler", () => {
    // Not a field on `Account` or `Tag`, and not a unique key on either.
    const BAD = { nope: 1 };

    const refusal = (schema: any, data: unknown) => {
      try {
        compileWrite(schema, "update", { where: { id: 1 }, data } as never, sqlite);
        return null;
      } catch (error) {
        return error as Error;
      }
    };

    /**
     * The operands that name an *existing* row by unique key, per path.
     *
     * `create` and `createMany` name no existing row. `updateMany` and
     * `deleteMany` take a filter rather than a unique key, so an undeclared
     * name there is a different question with a different answer. Those four
     * are absent deliberately.
     */
    const TO_MANY: [string, unknown][] = [
      ["connect", { connect: BAD }],
      ["connectOrCreate", { connectOrCreate: { where: BAD, create: {} } }],
      ["disconnect", { disconnect: BAD }],
      ["delete", { delete: BAD }],
      ["update", { update: { where: BAD, data: {} } }],
      ["upsert", { upsert: { where: BAD, create: {}, update: {} } }],
      ["set", { set: [BAD] }],
    ];

    // On a to-one the others take a boolean or carry no `where` at all.
    const TO_ONE: [string, unknown][] = [
      ["connect", { connect: BAD }],
      ["connectOrCreate", { connectOrCreate: { where: BAD, create: {} } }],
    ];

    const JOIN_TABLE: [string, unknown][] = [
      ["connect", { connect: BAD }],
      ["connectOrCreate", { connectOrCreate: { where: BAD, create: { name: "x" } } }],
      ["disconnect", { disconnect: BAD }],
      ["set", { set: [BAD] }],
    ];

    test.each(TO_MANY)("%s on a to-many (the child holds the key)", (_operand, operand) => {
      const error = refusal(user, { accounts: operand });
      expect(error?.message).toMatch(/needs a unique field here/);
    });

    test.each(TO_ONE)("%s on a to-one (this row holds the key)", (_operand, operand) => {
      const error = refusal(user, { organization: operand });
      expect(error?.message).toMatch(/needs a unique field here/);
    });

    test.each(JOIN_TABLE)("%s through a join table", (_operand, operand) => {
      const error = refusal(post, { tags: operand });
      expect(error?.message).toMatch(/needs a unique field here/);
    });
  });

  /**
   * **Every supported operand is answered on both sides, or refused by name.**
   *
   * `SUPPORTED` says which operands the ordinary-relation path accepts, but the
   * two sides are separate dispatches — `planOwningSide` when this row holds
   * the key, `planForeignSide` when the child does. An operand can be in the
   * set and unimplemented on one of them, and then it falls through to whatever
   * handler comes last: `upsert` reached the `connect` path and reported
   * `'where' yet (Organization.update.organization.connect)` — a different
   * operand, a different model, and a claim that `{ id: 1 }` is not a unique
   * key when it is.
   *
   * That is a gap `REFUSED` cannot cover, because the operand is not refused —
   * it is supported, on one side. This walks the set and asserts that whatever
   * comes back names the operand the caller actually wrote, which is the
   * property #85 was filed about.
   */
  describe("every supported operand answers for itself on both sides", () => {
    const OPERANDS = [
      "connect",
      "connectOrCreate",
      "create",
      "createMany",
      "disconnect",
      "delete",
      "update",
      "updateMany",
      "deleteMany",
      "set",
      "upsert",
    ];

    // `organization` is the to-one — this row holds the key. `accounts` is the
    // to-many — the child does.
    test.each(OPERANDS)("%s on a to-one names itself", (operand) => {
      let message = "";
      try {
        text("update", {
          where: { id: 1 },
          data: { organization: { [operand]: {} } },
        });
      } catch (error) {
        message = (error as Error).message;
      }

      // Either it compiled, or the refusal names the operand the caller wrote.
      //
      // The *model* is not asserted here — that is the subject of the fields
      // table above, which pins it to the caller's rather than the child's.
      // This walk is only about whether the operand names itself, which was
      // #85's question and is a separate one.
      if (message === "") return;
      expect(message).toContain(`.${operand}`);
    });

    test.each(OPERANDS)("%s on a to-many names itself", (operand) => {
      let message = "";
      try {
        text("update", {
          where: { id: 1 },
          data: { accounts: { [operand]: {} } },
        });
      } catch (error) {
        message = (error as Error).message;
      }

      if (message === "") return;
      expect(message).toContain(`.${operand}`);
    });
  });

  /**
   * The two operand sets, reconciled — and asserted, because nothing else can
   * see the divergence.
   *
   * `planOne` checks `link.join` first and returns, so the join-table path
   * never consults `SUPPORTED`. The sets can drift with nothing failing to
   * compile and no test noticing, which is exactly what happened while #83 and
   * four other branches were in flight at once.
   */
  describe("ordinary relations and implicit many-to-many", () => {
    const BOTH = ["connect", "connectOrCreate", "create", "disconnect", "set"];
    const ORDINARY_ONLY = [
      "createMany",
      "delete",
      "update",
      "updateMany",
      "deleteMany",
    ];

    /**
     * The remaining gaps, each with a reason that says whether it is Prisma's
     * refusal or this path's missing second hop — measured, not reasoned. An
     * earlier version of this test asserted a "link versus far row" split that
     * Prisma contradicts: it implements `delete` through a join table, and it
     * deletes the far row.
     */
    test.each(ORDINARY_ONLY)("%s is refused through a join table, with a reason", (operand) => {
      expect(() =>
        compileWrite(
          post,
          "update",
          { where: { id: 1 }, data: { tags: { [operand]: {} } } },
          sqlite,
        ),
      ).toThrow(/means something different through a join table/);
    });

    /**
     * **The step says which operand it is**, which is what the field is for.
     *
     * `NestedWriteStep.operation` is documented as the thing that "makes a plan
     * legible from the outside: to a test, and to whatever logs queries later"
     * — two steps on the same relation can produce byte-identical SQL and
     * differ only in what the step does.
     *
     * Nothing on the join-table path asserted it. Mutation found the hole:
     * flipping
     *
     *     operation: key === "create" ? "create" : "connect"
     *
     * survives the unit suite *and* the template suite, so a `create` step
     * could report itself as a `connect` and the only reader would be a human
     * debugging a plan.
     *
     * `plan.writes.discrimination.test.ts` does read the label, but folds it
     * into a plan-identity string and asserts two plans *differ*. Swapping the
     * two labels swaps both identities and they stay distinct, so that test
     * passes either way — the difference between checking a value and checking
     * that values are not equal.
     */
    test.each([
      ["create", { create: { label: "new" } }],
      ["connect", { connect: { id: 1 } }],
      ["connectOrCreate", { connectOrCreate: { where: { id: 1 }, create: { label: "new" } } }],
      ["disconnect", { disconnect: { id: 1 } }],
      ["set", { set: [{ id: 1 }] }],
    ] as [string, Record<string, unknown>][])(
      "a %s through a join table is labelled as one",
      (operand, payload) => {
        const plan = compileWrite(
          post,
          "update",
          { where: { id: 1 }, data: { tags: payload } } as never,
          sqlite,
        );

        const steps = [...(plan.before ?? []), ...(plan.after ?? [])];
        const labels = steps
          .filter((step) => step.relation === "tags")
          .map((step) => step.operation);

        expect(labels, `no step was planned for ${operand}`).not.toHaveLength(0);
        expect(labels).toContain(operand);
      },
    );

    test("the operands both paths implement are not refused there", () => {
      for (const operand of BOTH) {
        expect(() =>
          compileWrite(
            post,
            "update",
            { where: { id: 1 }, data: { tags: { [operand]: {} } } },
            sqlite,
          ),
        ).not.toThrow(/means something different/);
      }
    });
  });

  /**
   * `connectOrCreate` — find by a unique key, create only if it is not there.
   *
   * **A hit ignores `create` entirely**, which the name does not suggest: it is
   * connect-*or*-create, not upsert. Measured against Prisma — an existing row
   * kept its own values where the `create` payload named different ones — and
   * the differential cases pin it.
   */
  describe("connectOrCreate", () => {
    const entry = {
      where: { publicId: "o1" },
      create: { publicId: "o1", name: "Made" },
    };

    test("the owning side resolves before the parent insert", () => {
      const plan = compileWrite(
        user,
        "create",
        { data: { email: "a@b.c", organization: { connectOrCreate: entry } } },
        sqlite,
      );

      expect(plan.before).toHaveLength(1);
      expect(plan.before?.[0].operation).toBe("connectOrCreate");
      // The foreign key is on this row, so it is a bound column rather than a
      // second statement afterwards.
      expect(plan.after).toBeUndefined();
    });

    test("the foreign side resolves after it, and returns the key", () => {
      const plan = compileWrite(
        user,
        "create",
        {
          data: {
            email: "a@b.c",
            accounts: {
              connectOrCreate: {
                where: { publicId: "acc1" },
                create: { organizationRole: 1 },
              },
            },
          },
        },
        sqlite,
      );

      expect(plan.after).toHaveLength(1);
      expect(plan.after?.[0].operation).toBe("connectOrCreate");
      expect(plan.text).toContain(`"id"`);
    });

    test("a to-one refuses a list, as Prisma does", () => {
      expect(() =>
        text("create", {
          data: { email: "a@b.c", organization: { connectOrCreate: [entry] } },
        }),
      ).toThrow(/a list has no meaning/);
    });

    test("a to-many takes one or a list", () => {
      for (const operand of [entry, [entry, entry]]) {
        expect(() =>
          text("create", {
            data: {
              email: "a@b.c",
              accounts: {
                connectOrCreate: Array.isArray(operand)
                  ? operand.map(() => ({
                      where: { publicId: "acc1" },
                      create: { organizationRole: 1 },
                    }))
                  : { where: { publicId: "acc1" }, create: { organizationRole: 1 } },
              },
            },
          }),
        ).not.toThrow();
      }
    });

    test.each(["where", "create"])("a missing '%s' is refused by name", (key) => {
      const partial: Record<string, unknown> = { ...entry };
      delete partial[key];

      expect(() =>
        text("create", {
          data: { email: "a@b.c", organization: { connectOrCreate: partial } },
        }),
      ).toThrow(new RegExp(`Expected a '${key}' key`));
    });

    test("an unexpected key is refused rather than ignored", () => {
      expect(() =>
        text("create", {
          data: {
            email: "a@b.c",
            organization: { connectOrCreate: { ...entry, update: {} } },
          },
        }),
      ).toThrow(/Unexpected update/);
    });

    /**
     * Prisma's rule, and not merely ours: without a unique `where` the lookup
     * matches an arbitrary row and "connect or create" quietly becomes
     * "connect to whichever came back first".
     */
    test("a non-unique where is refused at compile time", () => {
      expect(() =>
        text("create", {
          data: {
            email: "a@b.c",
            organization: {
              connectOrCreate: { where: { name: "Acme" }, create: { name: "Acme" } },
            },
          },
        }),
      ).toThrow();
    });
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

/**
 * `_count` in a write's `include` (#87).
 *
 * It used to be accepted and dropped — the row came back without the key and
 * without an error — while an unknown relation name in the same `include`
 * raised. The inconsistency is the sharper half of the complaint: the write
 * path validated relation names and then discarded the one key that is not one.
 */
describe("_count on a write", () => {
  const COUNT = { _count: { select: { accounts: true } } };

  // The count correlates against the child's table, so its schema has to be
  // resolvable — same requirement the relation planner has.
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Account", class { static $schema = account });
    registry.register("Organization", class { static $schema = organization });
  });

  afterEach(() => registry.clearRegistry());

  test("projects a correlated subquery into the returning list", () => {
    const emitted = text("create", { data: { email: "a@b.c" }, include: COUNT });

    expect(emitted).toContain(`select count(*)`);
    expect(emitted).toContain(`from "Account"`);
    // In `returning`, not as a second statement: both dialects evaluate a
    // subquery there, so this costs no extra round trip.
    expect(emitted.slice(emitted.indexOf(" returning "))).toContain(`count(*)`);
  });

  test("it reaches every row-returning write", () => {
    for (const [op, args] of [
      ["create", { data: { email: "a@b.c" } }],
      ["update", { where: { id: 1 }, data: { name: "x" } }],
      ["delete", { where: { id: 1 } }],
      ["upsert", { where: { id: 1 }, create: { id: 1, email: "a@b.c" }, update: {} }],
    ] as const) {
      expect(text(op, { ...args, include: COUNT })).toContain(`count(*)`);
    }
  });

  test("the filter inside a _count is bound, never inlined", () => {
    const args = {
      data: { email: "a@b.c" },
      include: {
        _count: { select: { accounts: { where: { organizationRole: 7 } } } },
      },
    };
    const plan = compileWrite(user, "create", args, sqlite);

    expect(plan.text).not.toContain("7");
    expect(plan.bind(args, createBindContext())).toContain(7);
  });

  /**
   * The flag `$exec` reads to decide that a `delete` has something to read
   * *before* the row goes. A count is not a relation plan, so `relations` is
   * empty for a `_count` on its own and cannot carry this.
   *
   * It matters because the two dialects disagree: under `on delete cascade`
   * Postgres evaluates the subquery against the pre-statement snapshot and
   * returns the old count, SQLite evaluates it after the cascade and returns 0.
   * Prisma returns the old count on both.
   */
  test("a write carrying a _count says so, and one without does not", () => {
    expect(
      compileWrite(user, "delete", { where: { id: 1 }, include: COUNT }, sqlite)
        .counts,
    ).toBe(true);

    expect(
      compileWrite(user, "delete", { where: { id: 1 } }, sqlite).counts,
    ).toBeUndefined();

    // An `include` of a real relation is a relation plan, not a count.
    expect(
      compileWrite(
        user,
        "delete",
        { where: { id: 1 }, include: { accounts: true } },
        sqlite,
      ).counts,
    ).toBeUndefined();
  });

  test("an unknown relation inside a _count still raises", () => {
    expect(() =>
      text("create", {
        data: { email: "a@b.c" },
        include: { _count: { select: { nosuchrelation: true } } },
      }),
    ).toThrow(/nosuchrelation/);
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

/**
 * `Prisma.AnyNull` in a **write**, which Prisma refuses and gemi accepted.
 *
 * The sentinel has no enumerable properties, so `JSON.stringify` turned it into
 * the jsonb object `{}` — a plausible-looking value written to a nullable Json
 * column, on both dialects, with nothing raised. The same silent mis-store #222
 * closed for `DbNull` and `JsonNull`, left open for the third because it was
 * omitted from the map rather than refused: #259.
 *
 * Verified against Prisma 6.19.2 rather than inferred — `create` and `update`
 * both raise *"Invalid value for argument `settings`. Expected
 * NullableJsonNullValueInput"*.
 *
 * **These fail at bind, not at compile, and that is forced rather than chosen.**
 * Compile is a pure function of the argument *shape* and never sees a value
 * (invariant 2), so a value nobody may write cannot be detected there — the
 * same reason the upsert key-agreement check above binds first. What the
 * refusal keeps is the context: `valueBinder` closes over the schema and the
 * operation, so the message still names the field, the model and the call.
 */
describe("a write refuses Prisma.AnyNull", () => {
  class AnyNull {
    toString() {
      return "Prisma.AnyNull";
    }
  }

  beforeEach(() => {
    registry.clearRegistry();
    registry.register("AuditLog", class { static $schema = mapped });
  });

  const row = (payload: unknown) => ({
    id: 1,
    isArchived: false,
    occurredAt: new Date(0),
    payload,
  });

  /**
   * Every spelling that reaches a value, because they arrive through three
   * different call sites — `insertColumns`, `createManyColumns` and
   * `assignment` — and each one had to be routed through the binder that now
   * refuses. Covering only `create` would have left `createMany` writing `{}`.
   *
   * `{ payload: { set: … } }` is deliberately **not** here. On a `Json` column
   * `isOperatorObject` treats `set` as data rather than as an operator — its
   * comment gives the reason, that `{ set: … }` is a legal Json *value* and
   * nothing can tell the two apart structurally — so that spelling writes the
   * object `{"set":…}` and is not a write of `AnyNull` at all. Listing it would
   * assert a refusal that would contradict a decision made elsewhere on
   * purpose.
   */
  test.each([
    ["create", { data: row(new AnyNull()) }],
    ["createMany", { data: [row(new AnyNull())] }],
    ["update", { where: { id: 1 }, data: { payload: new AnyNull() } }],
    ["updateMany", { where: { id: 1 }, data: { payload: new AnyNull() } }],
  ] as [string, any][])("%s is refused", (op, args) => {
    const compiled = compileWrite(mapped, op as any, args, sqlite);

    expect(() => compiled.bind(args, createBindContext())).toThrow(
      InvalidArgumentError,
    );
  });

  /**
   * The message says what to write instead. A refusal that only says no leaves
   * the caller to guess between the two sentinels that *are* storable, and they
   * store different rows — the same reason the bare-filter refusal names the
   * one it got rather than the other.
   */
  test("the refusal names the field and both storable sentinels", () => {
    const args = { data: row(new AnyNull()) };
    const compiled = compileWrite(mapped, "create", args, sqlite);

    let message = "";
    try {
      compiled.bind(args, createBindContext());
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("data.payload");
    expect(message).toContain("AuditLog");
    expect(message).toContain("Prisma.DbNull");
    expect(message).toContain("Prisma.JsonNull");
  });

  // The other two still write, so the refusal is about `AnyNull` and not about
  // sentinels in general.
  test.each([
    ["Prisma.DbNull", null],
    ["Prisma.JsonNull", "null"],
  ])("%s still binds", (tag, expected) => {
    class Sentinel {
      toString() {
        return tag;
      }
    }
    const args = { data: row(new Sentinel()) };
    const compiled = compileWrite(mapped, "create", args, sqlite);

    expect(compiled.bind(args, createBindContext())).toContain(expected);
  });
});
