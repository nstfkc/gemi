import { describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { InvalidArgumentError, UnsupportedQueryError } from "../errors";
import { organization, user, userWithProfile } from "../fixtures";
import * as registry from "../registry";
import { planKey } from "../plan";
import { createBindContext } from "./fragment";
import { compileWrite } from "./write";

/**
 * `skipIfUnchanged` (#664) at the compiler: the `where` an update gains, and
 * when it gains none. What it does to real rows — `@updatedAt` untouched, the
 * row still returned, the count — is `templates/saas-starter/app/models/
 * skip-if-unchanged.test.ts`, on both dialects.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

function text(op: any, args: any, dialect: any = sqlite, schema = user) {
  return compileWrite(schema, op, args, dialect).text;
}

function bind(op: any, args: any, dialect: any = sqlite, schema = user) {
  return compileWrite(schema, op, args, dialect).bind(args, createBindContext());
}

describe("skipIfUnchanged", () => {
  test("adds a null-safe 'distinct' term per assigned column, not for @updatedAt", () => {
    const args = {
      where: { id: 1 },
      data: { name: "n", locale: "tr" },
      skipIfUnchanged: true,
    };

    expect(text("update", args)).toBe(
      `update "User" set "name" = ?, "locale" = ?, "updatedAt" = ? ` +
        `where ("id" = ?) and ("name" is not ? or "locale" is not ?) ` +
        `returning "id", "publicId", "name", "email", "emailVerifiedAt", ` +
        `"verificationToken", "locale", "globalRole", "password", ` +
        `"organizationId", "createdAt", "updatedAt", "deletedAt"`,
    );

    expect(text("update", args, postgres)).toContain(
      `where ("id" = $4) and ("name" is distinct from $5 or "locale" is distinct from $6)`,
    );

    const values = bind("update", args);
    expect(values[3]).toBe(1);
    expect(values.slice(4)).toEqual(["n", "tr"]);
  });

  test("updateMany gets the same term, after its own filter", () => {
    expect(
      text("updateMany", {
        where: { email: "a" },
        data: { name: "n" },
        skipIfUnchanged: true,
      }),
    ).toContain(`where ("email" = ?) and ("name" is not ?)`);

    expect(
      text("updateMany", { data: { name: "n" }, skipIfUnchanged: true }),
    ).toContain(`where ("name" is not ?)`);
  });

  test("false and absent compile to the plain update", () => {
    const plain = text("update", { where: { id: 1 }, data: { name: "n" } });
    expect(
      text("update", { where: { id: 1 }, data: { name: "n" }, skipIfUnchanged: false }),
    ).toBe(plain);
    expect(plain).not.toContain(" is not ");
  });

  test("`{ set }` compares the value it sets", () => {
    const args = {
      where: { id: 1 },
      data: { name: { set: "n" } },
      skipIfUnchanged: true,
    };
    expect(text("update", args)).toContain(`and ("name" is not ?)`);
    expect(bind("update", args).at(-1)).toBe("n");
  });

  test("an arithmetic operator always writes, so there is no guard", () => {
    // `user` has no numeric column besides the key; `globalRole` is an Int.
    const args = {
      where: { id: 1 },
      data: { name: "n", globalRole: { increment: 1 } },
      skipIfUnchanged: true,
    };
    expect(text("update", args)).not.toContain(" is not ");
  });

  test("a Json column compares as JSON on both dialects", () => {
    const args = {
      where: { id: 1 },
      data: { metadata: { a: 1 } },
      skipIfUnchanged: true,
    };
    expect(text("update", args, sqlite, userWithProfile)).toContain(
      `and (json("metadata") is not json(?))`,
    );
    expect(text("update", args, postgres, userWithProfile)).toContain(
      `and (("metadata")::jsonb is distinct from $4::text::jsonb)`,
    );
  });

  test("a DateTime compares in its stored encoding", () => {
    const at = new Date("2026-01-02T03:04:05.678Z");
    const values = bind("update", {
      where: { id: 1 },
      data: { emailVerifiedAt: at },
      skipIfUnchanged: true,
    });
    // `set` and the guard bind the same encoded value.
    expect(values[0]).toBe(at.getTime());
    expect(values.at(-1)).toBe(at.getTime());
  });

  test("an empty data reads the row, with or without the option", () => {
    expect(
      text("update", { where: { id: 1 }, data: {}, skipIfUnchanged: true }),
    ).toMatch(/^select /);
  });

  test("a nested relation write is refused by name", () => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Organization", class { static $schema = organization });
    try {
      expect(() =>
        text("update", {
          where: { id: 1 },
          data: { name: "x", organization: { connect: { id: 2 } } },
          skipIfUnchanged: true,
        }),
      ).toThrow(/cannot be combined with a nested relation write/);
    } finally {
      registry.clearRegistry();
    }
  });

  test("a non-boolean is refused", () => {
    expect(() =>
      text("update", { where: { id: 1 }, data: { name: "n" }, skipIfUnchanged: "yes" }),
    ).toThrow(InvalidArgumentError);
  });

  test("is not an upsert argument", () => {
    expect(() =>
      text("upsert", {
        where: { id: 1 },
        create: { email: "e" },
        update: { name: "n" },
        skipIfUnchanged: true,
      }),
    ).toThrow(UnsupportedQueryError);
  });

  test("true and false are two plan keys, on both dialects", () => {
    for (const dialect of [sqlite, postgres]) {
      const base = { where: { id: 1 }, data: { name: "n" } };
      const on = planKey(dialect, "User", "update", { ...base, skipIfUnchanged: true });
      const off = planKey(dialect, "User", "update", { ...base, skipIfUnchanged: false });
      const absent = planKey(dialect, "User", "update", base);
      expect(on).not.toBe(off);
      expect(on).not.toBe(absent);
    }
  });

  test("a column named skipIfUnchanged inside where stays a value", () => {
    const a = planKey(sqlite, "User", "findMany", { where: { skipIfUnchanged: true } });
    const b = planKey(sqlite, "User", "findMany", { where: { skipIfUnchanged: false } });
    expect(a).toBe(b);
  });
});
