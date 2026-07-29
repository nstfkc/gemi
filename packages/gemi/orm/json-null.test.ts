import { describe, expect, test } from "vitest";

import { JSON_NULL, jsonNullKind } from "./json-null";

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
    ["Prisma.AnyNull", "any"],
  ] as const)("%s is recognised", (tag, kind) => {
    expect(jsonNullKind(sentinelShaped(tag))).toBe(kind);
  });

  /**
   * `AnyNull` is recognised, and the reason it needs saying is that the other
   * two are *storable* and it is not.
   *
   * `DbNull` and `JsonNull` each name one of a nullable Json column's two legal
   * empty states, so an encoder can turn either into something to write.
   * `AnyNull` names both at once — a question about existing rows, which Prisma
   * refuses in a write and answers as `is null or = 'null'` in a filter
   * (verified against 6.19.2 directly, not inferred from the docs).
   *
   * It used to be absent from the table, and absent is not refused: it fell
   * through to the data path, where a write stored it as the jsonb object `{}`
   * and `{ equals: AnyNull }` compiled to `= '{}'` — the exact complement of
   * the rows it asks for, since no row holding either null holds an empty
   * object. That was #259. The kind is mapped here; the two call sites that
   * cannot encode it refuse it, and `compile/where.ts` implements the filter.
   */
  test("Prisma.AnyNull is recognised as its own kind, not as data", () => {
    expect(jsonNullKind(sentinelShaped("Prisma.AnyNull"))).toBe("any");
  });

  /**
   * The compiler's own `JsonNull`, which `compile/where.ts` binds as the
   * right-hand side of `AnyNull`'s `or` — the caller wrote `AnyNull`, so there
   * is no `JsonNull` in the argument tree to read it out of.
   *
   * Pinned here rather than where it is used because the failure is remote from
   * the change that causes it: it is built as a class so its prototype's
   * `toString` is non-enumerable, and rebuilding it as an object literal would
   * make `for…in` walk the method and this recogniser reject it. The filter
   * would then bind `{}` and match nothing — #259 restored, from the other end.
   */
  test("the compiler's own JsonNull is recognised as the real one", () => {
    expect(jsonNullKind(JSON_NULL)).toBe("json");
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
