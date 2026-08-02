import { describe, expect, test } from "vitest";

import { compileRead } from "./compile/read";
import { compileWrite } from "./compile/write";
import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { DecodeError, UnsupportedQueryError } from "./errors";
import type { FieldSchema, ModelSchema } from "./schema";

const postgres = new PostgresDialect();
const sqlite = new SqliteDialect();

/**
 * Scalar lists, at the level the differential harness **cannot** reach (#300).
 *
 * `templates/saas-starter/app/models/scalar-list.test.ts` is the oracle: it runs
 * every filter and every write through Prisma and through gemi against one
 * Postgres and compares rows. It is the stronger test and it is where a
 * behavioural question gets settled.
 *
 * Three things are structurally out of its reach, and they are what this file
 * is for:
 *
 *  1. **The array-literal parser's escaping.** The parser only runs for an array
 *     type Bun has no decoder for, which in practice means an `enum[]`. A Prisma
 *     enum member is `[A-Za-z][A-Za-z0-9_]*`, and Postgres quotes an array
 *     element only when it contains a delimiter, a quote or a backslash — so no
 *     schema Prisma will accept can produce a quoted element there. The escaping
 *     is real code on a real path and nothing Prisma can write exercises it.
 *  2. **SQLite's refusal.** Prisma refuses the *column* on SQLite, so there is
 *     no SQLite client to compare against — by construction, forever.
 *  3. **The SQL text.** A differential says the answers agree; it cannot say
 *     the statement is the one that keeps the plan cache honest.
 */

function field(overrides: Partial<FieldSchema>): FieldSchema {
  return {
    name: "tags",
    column: "tags",
    type: "String",
    nullable: false,
    isId: false,
    isUpdatedAt: false,
    isList: true,
    ...overrides,
  };
}

const TAGGED: ModelSchema = {
  name: "Tagged",
  table: "Tagged",
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
    tags: field({}),
    counts: field({ name: "counts", column: "counts", type: "Int" }),
    docs: field({ name: "docs", column: "docs", type: "Json" }),
    renamed: field({ name: "renamed", column: "renamed_column" }),
  },
  primaryKey: ["id"],
  uniques: [["id"]],
  relations: {},
};

/** The value actually bound for a list operand, as Postgres array-literal text. */
function bound(value: unknown, overrides: Partial<FieldSchema> = {}): unknown {
  return postgres.encode(value, field(overrides));
}

describe("the Postgres array literal, written", () => {
  test("quotes every element, whatever its type", () => {
    expect(bound(["a", "b"])).toBe('{"a","b"}');
    expect(bound([1, 2], { type: "Int" })).toBe('{"1","2"}');
    expect(bound([true], { type: "Boolean" })).toBe('{"true"}');
  });

  test("the empty list is {}", () => {
    expect(bound([])).toBe("{}");
  });

  /**
   * The four characters that would otherwise end the element early, plus the
   * one that cannot be quoted at all.
   */
  test("escapes the delimiters", () => {
    expect(bound(['a"b'])).toBe('{"a\\"b"}');
    expect(bound(["a\\b"])).toBe('{"a\\\\b"}');
    expect(bound(["a,b"])).toBe('{"a,b"}');
    expect(bound(["{a}"])).toBe('{"{a}"}');
    expect(bound([""])).toBe('{""}');
  });

  test("a null element is unquoted NULL, which is not the string", () => {
    expect(bound([null])).toBe("{NULL}");
    expect(bound(["NULL"])).toBe('{"NULL"}');
  });

  /**
   * `Json` elements are serialised here rather than by `fieldParam`, because a
   * list emits no cast for `fieldParam` to travel with — see the note on
   * `encode`. Without it `String({a:1})` is `[object Object]`.
   */
  test("serialises Json elements", () => {
    expect(bound([{ a: 1 }], { type: "Json" })).toBe('{"{\\"a\\":1}"}');
    expect(bound(["42"], { type: "Json" })).toBe('{"\\"42\\""}');
    expect(bound([7], { type: "Json" })).toBe('{"7"}');
  });

  test("a bigint past 2^53 keeps every digit", () => {
    expect(bound([9007199254740993n], { type: "BigInt" })).toBe(
      '{"9007199254740993"}',
    );
  });

  test("bytes take the doubled-backslash hex form", () => {
    expect(bound([new Uint8Array([1, 2, 255])], { type: "Bytes" })).toBe(
      '{"\\\\x0102ff"}',
    );
  });
});

/**
 * The parser, which only an `enum[]` reaches through the driver — and which no
 * Prisma-legal enum can push past the unquoted case. See the header.
 */
describe("the Postgres array literal, read back", () => {
  const read = (text: string, overrides: Partial<FieldSchema> = {}) =>
    postgres.decode(text, field(overrides));

  test("splits unquoted elements", () => {
    expect(read("{urgent,blocked}")).toEqual(["urgent", "blocked"]);
  });

  test("the empty literal is the empty list, not [\"\"]", () => {
    expect(read("{}")).toEqual([]);
  });

  /**
   * The case a `split(",")` gets wrong, and the reason this is a state machine.
   */
  test("a quoted element may contain the delimiter", () => {
    expect(read('{a,"b,c",d}')).toEqual(["a", "b,c", "d"]);
  });

  test("unescapes quotes and backslashes", () => {
    expect(read('{"a\\"b"}')).toEqual(['a"b']);
    expect(read('{"a\\\\b"}')).toEqual(["a\\b"]);
  });

  test("a brace inside quotes is content, not nesting", () => {
    expect(read('{"{a}"}')).toEqual(["{a}"]);
  });

  test("unquoted NULL is null; quoted NULL is the string", () => {
    expect(read("{NULL}")).toEqual([null]);
    expect(read('{"NULL"}')).toEqual(["NULL"]);
  });

  test("an empty quoted element is the empty string", () => {
    expect(read('{"",a}')).toEqual(["", "a"]);
  });

  /**
   * Prisma's scalar lists are one-dimensional. Flattening a nested literal would
   * return a row shape that disagrees with the type Prisma handed the caller,
   * which is the failure this feature was refused for eight iterations to avoid.
   */
  test("refuses a multi-dimensional literal rather than flattening it", () => {
    expect(() => read("{{a,b},{c}}")).toThrow(DecodeError);
  });

  test("refuses text that is not a literal at all", () => {
    expect(() => read("a,b")).toThrow(DecodeError);
  });
});

describe("decoding the containers the driver actually returns", () => {
  test("a plain array decodes element-wise", () => {
    expect(postgres.decode(["1", "2"], field({ type: "BigInt" }))).toEqual([
      1n,
      2n,
    ]);
  });

  /**
   * `int[]` arrives as an `Int32Array` over the extended protocol and a plain
   * `Array` over the simple one — the same statement, two containers, decided
   * by whether it bound a parameter. Prisma returns `number[]` for both.
   */
  test("a typed array becomes a plain array", () => {
    const decoded = postgres.decode(
      new Int32Array([1, 2]),
      field({ type: "Int" }),
    );
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toEqual([1, 2]);
  });

  /**
   * `Buffer` is a `Uint8Array` subclass, so a divergence here survives the
   * generated type and any element-wise comparison — and `toString("hex")`
   * reads `"0102ff"` from one and `"1,2,255"` from the other.
   */
  test("Buffer elements become Uint8Array, as Prisma returns", () => {
    const decoded = postgres.decode(
      [Buffer.from([1, 2, 255])],
      field({ type: "Bytes" }),
    ) as unknown[];
    expect(decoded[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(decoded[0])).toBe(false);
  });

  test("a null column stays null rather than becoming []", () => {
    expect(postgres.decode(null, field({}))).toBeNull();
  });

  test("null elements survive", () => {
    expect(postgres.decode(["a", null], field({}))).toEqual(["a", null]);
  });

  /** Every list is decoded — see the note on `needsDecode` for why. */
  test("needsDecode is true for a list of any element type", () => {
    expect(postgres.needsDecode(field({ type: "String" }))).toBe(true);
    expect(postgres.needsDecode(field({ type: "Int" }))).toBe(true);
  });
});

describe("the parameter cast", () => {
  /**
   * The ordering is the whole check: a `Json[]` binding `$1::text::jsonb`
   * against a `jsonb[]` column is a type error, and `Json` is the branch it
   * would otherwise take.
   */
  test("a list gets no cast, including a Json list", () => {
    expect(postgres.castParameter(field({ type: "Json" }))).toBe("");
    expect(postgres.castParameter(field({ type: "String" }))).toBe("");
  });

  test("a scalar Json still gets one", () => {
    expect(postgres.castParameter(field({ type: "Json", isList: false }))).toBe(
      "::text::jsonb",
    );
  });
});

describe("the SQL a list filter compiles to", () => {
  const read = (where: unknown) =>
    compileRead(TAGGED, "findMany" as never, { where } as never, postgres).text;

  test("has puts the element on the left of = any", () => {
    expect(read({ tags: { has: "a" } })).toContain(`$1 = any("tags")`);
  });

  test("hasEvery is containment and hasSome is overlap", () => {
    expect(read({ tags: { hasEvery: ["a"] } })).toContain(`"tags" @> $1`);
    expect(read({ tags: { hasSome: ["a"] } })).toContain(`"tags" && $1`);
  });

  test("equals is whole-list equality", () => {
    expect(read({ tags: { equals: ["a"] } })).toContain(`"tags" = $1`);
  });

  test("isEmpty compares against a bound empty list, with no digit in the text", () => {
    const empty = read({ tags: { isEmpty: true } });
    expect(empty).toContain(`"tags" = $1`);
    expect(empty.replace(/"[^"]*"|\$\d+/g, "")).not.toMatch(/\d/);
    expect(read({ tags: { isEmpty: false } })).toContain(`"tags" <> $1`);
  });

  test("the column is the mapped name, not the field name", () => {
    expect(read({ renamed: { has: "a" } })).toContain(`= any("renamed_column")`);
  });

  /**
   * Invariant 2, at the point most likely to break it: the operand is a caller
   * value and the list is the caller's too, so nothing about its *length* may
   * reach the text.
   */
  test("two lists of different lengths compile to the same text", () => {
    expect(read({ tags: { hasEvery: ["a"] } })).toBe(
      read({ tags: { hasEvery: ["a", "b", "c"] } }),
    );
  });

  test("has and equals compile differently, so they cannot share a plan", () => {
    expect(read({ tags: { has: "a" } })).not.toBe(read({ tags: { equals: ["a"] } }));
  });
});

describe("the SQL a list write compiles to", () => {
  const write = (data: unknown) =>
    compileWrite(
      TAGGED,
      "update" as never,
      { where: { id: 1 }, data } as never,
      postgres,
    ).text;

  test("set is a plain assignment", () => {
    expect(write({ tags: { set: ["a"] } })).toContain(`"tags" = $`);
  });

  test("push reads the column back through array_cat", () => {
    expect(write({ tags: { push: "a" } })).toContain(`"tags" = array_cat("tags", $`);
  });

  /**
   * `push: "a"` and `push: ["a"]` are the same statement, which is what lets the
   * dialect use a single-signature function — `||` would read the two spellings
   * as different operators.
   */
  test("push of one and push of many compile alike", () => {
    expect(write({ tags: { push: "a" } })).toBe(write({ tags: { push: ["a"] } }));
  });

  test("a bare array is a value, not an operator", () => {
    expect(write({ tags: ["a"] })).toContain(`"tags" = $`);
    expect(write({ tags: ["a"] })).not.toContain("array_cat");
  });
});

/**
 * Refusals. Each one names the field's *kind*, because "unsupported" sends a
 * reader looking for a release note when the fix is in their own call.
 */
describe("refusals", () => {
  const read = (where: unknown, dialect = postgres) =>
    compileRead(TAGGED, "findMany" as never, { where } as never, dialect).text;

  /**
   * Prisma refuses this too — *"Expected StringNullableListFilter, provided
   * (String)"* — and accepting it made gemi a silent superset on the one
   * dialect where every other answer can be checked against Prisma.
   */
  test("a bare array is not a filter, and the message says what is", () => {
    expect(() => read({ tags: ["a"] })).toThrow(/bare array is not a filter/);
    expect(() => read({ tags: ["a"] })).toThrow(/equals/);
  });

  test("a scalar operator on a list names both operator sets", () => {
    expect(() => read({ tags: { contains: "a" } })).toThrow(
      /list filter takes.*equals, has, hasEvery, hasSome, isEmpty/s,
    );
    expect(() => read({ tags: { contains: "a" } })).toThrow(/scalar operators/);
  });

  test("hasEvery and hasSome refuse a non-array, naming the type received", () => {
    expect(() => read({ tags: { hasEvery: "a" } })).toThrow(
      /Expected an array, received string/,
    );
    expect(() => read({ tags: { hasSome: 1 } })).toThrow(
      /Expected an array, received number/,
    );
  });

  test("isEmpty refuses a non-boolean", () => {
    expect(() => read({ tags: { isEmpty: "yes" } })).toThrow(
      /Expected true or false/,
    );
  });

  test("equals refuses a scalar and points at has", () => {
    expect(() => read({ tags: { equals: "a" } })).toThrow(/has/);
  });

  /**
   * The refusal that moved from the generator to here (#300). It has to say
   * more than "unsupported": the reader's likeliest question is whether they
   * did something wrong, and they did not.
   */
  test("SQLite refuses the column and explains that Prisma does too", () => {
    expect(() => read({ tags: { has: "a" } }, sqlite)).toThrow(
      UnsupportedQueryError,
    );
    expect(() => read({ tags: { has: "a" } }, sqlite)).toThrow(
      /sqlite has no array type/,
    );
    expect(() => read({ tags: { has: "a" } }, sqlite)).toThrow(
      /lists of primitive types/,
    );
    expect(() => read({ tags: { has: "a" } }, sqlite)).toThrow(/It works on postgres/);
  });

  test("SQLite refuses a list write too, not only a filter", () => {
    expect(() =>
      compileWrite(
        TAGGED,
        "update" as never,
        { where: { id: 1 }, data: { tags: { set: ["a"] } } } as never,
        sqlite,
      ),
    ).toThrow(/sqlite has no array type/);
  });

  test("SQLite's list fragments are unreachable but still refuse loudly", () => {
    expect(() => sqlite.listHas()).toThrow(/listFilters` is the guard/);
    expect(() => sqlite.listPush()).toThrow(/listFilters` is the guard/);
  });

  /**
   * At **compile** time, which is the point. `isOperatorObject` answers false
   * for an operator a list does not have, so this used to be read as a *value*
   * and travelled to the binder before anything objected.
   */
  test("an arithmetic operator on a list names set and push", () => {
    const bad = () =>
      compileWrite(
        TAGGED,
        "update" as never,
        { where: { id: 1 }, data: { counts: { increment: 1 } } } as never,
        postgres,
      );
    expect(bad).toThrow(/scalar list, so it takes set or push/);
    expect(bad).toThrow(/Received \{ increment \}/);
  });

  /**
   * `push` is legal on `update` and not on `create`, which is Prisma's split:
   * its create input for a list is `T[] | { set: T[] }`, and there is nothing
   * for a `push` to append to on a row that does not exist yet. The error names
   * the operators legal *in this position* rather than the operators a list has
   * in general, which is the difference between a next step and a puzzle.
   */
  test("push is refused on create, naming only what create takes", () => {
    const bad = () =>
      compileWrite(
        TAGGED,
        "create" as never,
        { data: { tags: { push: ["a"] } } } as never,
        postgres,
      );
    expect(bad).toThrow(/scalar list, so it takes set —/);
    expect(bad).toThrow(/Received \{ push \}/);
  });
});
