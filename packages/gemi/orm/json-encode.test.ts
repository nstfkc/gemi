import { describe, expect, test } from "vitest";

import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import type { FieldSchema } from "./schema";

const postgres = new PostgresDialect();
const sqlite = new SqliteDialect();

const metadata = {
  name: "metadata",
  column: "metadata",
  type: "Json",
  nullable: true,
  isId: false,
  isUpdatedAt: false,
} as FieldSchema;

/**
 * How a `Json` value is bound, and the one shape where that **diverges from
 * Prisma**.
 *
 * `dialect/postgres.ts` hands `Json` over raw, for a measured reason: the
 * encoder that serialised first stored `42` as the jsonb *string* `"42"` —
 * confirmed with `jsonb_typeof` — and only looked correct because the decoder
 * re-parsed it on the way out. Raising beats storing the wrong thing, and that
 * trade is not what this file questions.
 *
 * What it pins is the consequence, which nothing asserted. Binding raw means a
 * bare number or boolean reaches Postgres as its own type, and `jsonb` will not
 * take it:
 *
 *     column "metadata" is of type jsonb but expression is of type integer
 *
 * **Prisma stores it.** Measured against Prisma 6.19 and Postgres 16 through the
 * differential harness: `metadata: 42` succeeds under Prisma on both dialects
 * and raises under gemi on Postgres. So the divergence a caller meets is from
 * *Prisma*, not between the two dialects as `docs/orm.md` described it — which
 * is the part of that section this change corrects.
 *
 * Asserted here rather than end-to-end because an end-to-end version has to
 * write through both clients into the harness's shared Postgres database, and
 * doing so perturbs the suites that share it. The encoder is where the
 * behaviour lives, and it is the thing that would have to change.
 */
describe("a Json value is bound raw", () => {
  const shapes: [string, unknown][] = [
    ["an object", { a: 1 }],
    ["an array", [1, 2]],
    ["a string", "42"],
    ["a bare number", 42],
    ["a bare boolean", true],
  ];

  test.each(shapes)("%s is handed to the driver unchanged — postgres", (_label, value) => {
    expect(postgres.encode(value, metadata)).toBe(value);
  });

  test.each(shapes)("%s is handed to the driver unchanged — sqlite", (_label, value) => {
    // SQLite serialises rather than binding raw, so this asserts the round trip
    // instead: whatever it does on the way in, `decode` has to undo.
    expect(sqlite.decode(sqlite.encode(value, metadata), metadata)).toEqual(value);
  });

  /**
   * Null is the one value both dialects normalise, and it has to stay `null`
   * rather than becoming the JSON text `"null"` — the difference between a
   * column that is empty and one holding a JSON null.
   */
  test.each([
    ["postgres", postgres],
    ["sqlite", sqlite],
  ])("null stays null — %s", (_name, dialect) => {
    expect(dialect.encode(null, metadata)).toBeNull();
    expect(dialect.encode(undefined, metadata)).toBeNull();
  });

  /**
   * The one that documents the divergence. A bare scalar arriving at the driver
   * as a JS number or boolean is precisely why `jsonb` rejects it — if this ever
   * starts returning a string, the refusal is gone and `docs/orm.md` needs
   * changing with it.
   */
  test.each([
    ["a number", 42],
    ["a boolean", true],
  ])("%s reaches postgres as its own type, which is why jsonb refuses it", (_label, value) => {
    const encoded = postgres.encode(value, metadata);

    expect(typeof encoded).toBe(typeof value);
    expect(typeof encoded).not.toBe("string");
  });

  /**
   * ...and the string case, which is what the raw binding exists to protect: a
   * JSON string that looks like a number must not become the number.
   */
  test("a JSON string is not turned into a number", () => {
    expect(postgres.encode("42", metadata)).toBe("42");
    expect(sqlite.decode(sqlite.encode("42", metadata), metadata)).toBe("42");
  });
});
