import { describe, expect, test } from "vitest";

import { SqliteDialect } from "../dialect/sqlite";
import { InvalidArgumentError, UnsupportedQueryError } from "../errors";
import { membership, user } from "../fixtures";
import { compileRead } from "./read";
import { isUniqueKeyValue } from "./unique";
import { compileWrite } from "./write";

/**
 * A unique key matches a row by *equality*. Before this, a plain object or an
 * array in a key position compiled as a scalar filter, so a request body that
 * reached `findUnique` unchecked could replace "the row whose key is this"
 * with "any row this filter matches" — `{ pin_email: { pin: {}, email } }`
 * matched on the email alone. Prisma types these positions as plain values;
 * the ORM now refuses anything else, whatever the operation.
 */

const sqlite = new SqliteDialect();

const NOT_VALUES: Array<[string, unknown]> = [
  ["an empty object", {}],
  ["a not filter", { not: "x" }],
  ["an in filter", { in: ["1", "2"] }],
  ["a gt filter", { gt: "" }],
  ["a startsWith filter", { startsWith: "" }],
  ["a nested filter", { not: { equals: "x" } }],
  ["an array", ["a", "b"]],
  ["null", null],
];

describe("isUniqueKeyValue", () => {
  test.each([
    ["a string", "a"],
    ["an empty string", ""],
    ["a number", 1],
    ["a bigint", 1n],
    ["a boolean", true],
    ["a Date", new Date()],
    ["bytes", new Uint8Array([1])],
    ["a class instance (Decimal)", new (class Decimal {})()],
  ])("%s is a key value", (_, value) => {
    expect(isUniqueKeyValue(value)).toBe(true);
  });

  test.each(NOT_VALUES)("%s is not", (_, value) => {
    expect(isUniqueKeyValue(value)).toBe(false);
  });

  test("an object with a null prototype is not", () => {
    expect(isUniqueKeyValue(Object.create(null))).toBe(false);
  });
});

describe("a compound unique key takes plain values only", () => {
  const key = (organizationId: unknown) => ({
    organizationId_userId: { organizationId, userId: 2 },
  });

  test.each(NOT_VALUES)("findUnique refuses %s", (_, value) => {
    expect(() =>
      compileRead(membership, "findUnique", { where: key(value) }, sqlite),
    ).toThrow(InvalidArgumentError);
  });

  test.each(NOT_VALUES)("findFirst refuses %s too", (_, value) => {
    // Not a unique lookup, but the compound spelling is still equality.
    expect(() =>
      compileRead(membership, "findFirst", { where: key(value) }, sqlite),
    ).toThrow(InvalidArgumentError);
  });

  test.each(["update", "delete"] as const)("%s refuses a filter", (op) => {
    const args = op === "update"
      ? { where: key({ not: 0 }), data: { role: 1 } }
      : { where: key({ not: 0 }) };
    expect(() => compileWrite(membership, op, args, sqlite)).toThrow(
      InvalidArgumentError,
    );
  });

  test("the error names the member", () => {
    try {
      compileRead(membership, "findUnique", { where: key({}) }, sqlite);
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidArgumentError).argument).toBe(
        "where.organizationId_userId.organizationId",
      );
    }
  });

  test("plain values still compile to equality on both members", () => {
    const where = key(1);
    const plan = compileRead(membership, "findUnique", { where }, sqlite);
    expect(plan.text).toContain(`"organizationId" = ?`);
    expect(plan.text).toContain(`"userId" = ?`);
    expect(plan.bind({ where })).toEqual([1, 2, 1]);
  });
});

describe("a single-field unique key takes plain values only", () => {
  test.each(NOT_VALUES)("findUnique by email refuses %s", (_, value) => {
    expect(() =>
      compileRead(user, "findUnique", { where: { email: value } }, sqlite),
    ).toThrow(InvalidArgumentError);
  });

  test.each(NOT_VALUES)("findUnique by id refuses %s", (_, value) => {
    expect(() =>
      compileRead(user, "findUnique", { where: { id: value } }, sqlite),
      // A string operator on an Int is refused by the filter compiler first.
    ).toThrow(UnsupportedQueryError);
  });

  test("update and delete refuse a filter as the key", () => {
    expect(() =>
      compileWrite(
        user,
        "update",
        { where: { email: { not: "" } }, data: { name: "x" } },
        sqlite,
      ),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      compileWrite(user, "delete", { where: { email: { contains: "" } } }, sqlite),
    ).toThrow(InvalidArgumentError);
  });

  test("a plain key with extra non-unique filters still compiles", () => {
    // `UserProvider.findUserByEmailAddress` relies on this.
    const where = { email: "a@b.co", deletedAt: { not: null } };
    const plan = compileRead(user, "findUnique", { where }, sqlite);
    expect(plan.text).toContain(`"email" = ?`);
    expect(plan.text).toContain(`"deletedAt" is not null`);
  });

  test("filters on the same field stay available outside a unique lookup", () => {
    // `findFirst` and `findMany` take a filter on any field, unique or not —
    // which is why a caller passing request input there must check its type.
    expect(() =>
      compileRead(user, "findFirst", { where: { email: { contains: "@" } } }, sqlite),
    ).not.toThrow();
    expect(() =>
      compileRead(user, "findMany", { where: { id: { in: [1, 2] } } }, sqlite),
    ).not.toThrow();
  });
});
