import { describe, expect, test } from "vitest";

import { jsonNullKind } from "./json-null";

/**
 * What may and may not be mistaken for one of Prisma's `Json` null sentinels.
 *
 * The first version recognised them by `toString` alone, which had two faults
 * and neither showed up in the differential suite, because no reasonable corpus
 * contains the values that trigger them:
 *
 *   { a: 1, toString: () => "Prisma.DbNull" }   read as the sentinel -> stored
 *                                               as SQL NULL, losing the object
 *   { a: 1, toString() { throw … } }            the *bind* threw, for a value
 *                                               Prisma stores without ever
 *                                               calling `toString`
 *
 * The first is the serious one: a forgeable sentinel whose failure is silent
 * data loss. `policy.ts` makes the same point in the other direction — its
 * provenance marker is a module-private `Symbol` precisely so "an application
 * cannot forge it".
 *
 * The fix is structural rather than textual: a sentinel carries **no data**, so
 * anything with a property in it is not one and never reaches `String`. These
 * cases are the boundary of that rule, written as a table because the
 * interesting ones are the values that look like sentinels and are not.
 *
 * **The real objects are not exercised here, and this file does not own that
 * guarantee.** `Prisma.DbNull` and `Prisma.JsonNull` cannot be constructed in
 * this package — the ORM runtime may not import the Prisma client package,
 * which `runtime-isolation.test.ts` enforces against comments too, and the
 * package has no generated client to import one from — so they are modelled by
 * their shape: no own properties, no enumerable keys, and a `toString` on the
 * prototype. That is exactly how the real ones are built.
 *
 * The genuine articles are covered end to end in the template, against a live
 * database and both dialects:
 *
 *   templates/saas-starter/app/models/writes.differential.test.ts
 *     `create with Prisma.DbNull` / `create with Prisma.JsonNull`
 *   templates/saas-starter/app/models/differential.test.ts
 *     `equals` / bare / `not` for both sentinels
 *
 * Worth naming, because the structural check is *tighter* than the `toString`
 * one it replaced: a Prisma release that gave its sentinels any own property
 * would stop them being recognised, and the failure would be a silent return to
 * #222's `{}` mis-store. Nothing in this package would see it — only those two
 * suites would, and they need a database, so a SQLite-only run does not.
 */
const sentinelShaped = (tag: string): object => {
  // A **class** instance, not `Object.create({ toString() {…} })`. A method in
  // an object literal is enumerable, so `for…in` walks it and the shape check
  // rejects it — which is how the first version of this helper failed while the
  // real sentinels passed. Prisma builds them as classes, where the prototype's
  // `toString` is non-enumerable, and that difference is the whole reason the
  // structural test is safe to apply.
  class Sentinel {
    toString() {
      return tag;
    }
  }
  return new Sentinel();
};

describe("jsonNullKind recognises a sentinel and nothing else", () => {
  test.each([
    ["Prisma.DbNull", "db"],
    ["Prisma.JsonNull", "json"],
  ] as const)("%s is recognised", (tag, kind) => {
    expect(jsonNullKind(sentinelShaped(tag))).toBe(kind);
  });

  /**
   * `AnyNull` is not mapped — and this pins only that, because **not mapped is
   * not refused**. It falls through to the data path, where a write stores it
   * as the jsonb object `{}` and `{ equals: AnyNull }` compiles to `= '{}'`,
   * returning the exact complement of the rows it asks for; Prisma raises on
   * the first and answers both kinds of null on the second.
   *
   * So the assertion below says what the function does, not that the omission
   * bought parity. Closing the gap means recognising `AnyNull` and refusing it
   * in a write the way #225 refuses a bare sentinel in a filter, and deciding
   * the filter half separately — #259.
   */
  test("Prisma.AnyNull is not mapped to a kind (and is not refused either — #259)", () => {
    expect(jsonNullKind(sentinelShaped("Prisma.AnyNull"))).toBeNull();
  });

  test.each([
    ["a plain object", { a: 1 }],
    ["an array", [1, 2]],
    ["an empty object", {}],
    ["an empty array", []],
    ["a string", "Prisma.DbNull"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["a Date", new Date(0)],
  ])("%s is not a sentinel", (_label, value) => {
    expect(jsonNullKind(value)).toBeNull();
  });

  /**
   * The forgery. An object that answers `Prisma.DbNull` was written as SQL NULL
   * and the object was lost — silently, because both are legal values for the
   * column.
   */
  test("an object carrying data cannot forge a sentinel", () => {
    const forged = { a: 1, toString: () => "Prisma.DbNull" };

    expect(jsonNullKind(forged)).toBeNull();
  });

  /** And the throw: `JSON.stringify` never calls `toString`, so nor may this. */
  test("a value whose toString throws is data, not an error", () => {
    const hostile = {
      a: 1,
      toString() {
        throw new Error("toString should not have been called");
      },
    };

    expect(() => jsonNullKind(hostile)).not.toThrow();
    expect(jsonNullKind(hostile)).toBeNull();
  });

  /**
   * A null-prototype object has no `toString` at all, and `String` throws on
   * it. It is a legitimate Json value — `JSON.stringify` handles it — so the
   * answer is "not a sentinel" rather than a failed write.
   */
  test("a null-prototype object does not fail the write", () => {
    const bare = Object.assign(Object.create(null), { a: 1 });

    expect(() => jsonNullKind(bare)).not.toThrow();
    expect(jsonNullKind(bare)).toBeNull();
    expect(jsonNullKind(Object.create(null))).toBeNull();
  });
});
