import { describe, expect, test } from "vitest";

import { user } from "../fixtures";
import { compileRead } from "../compile/read";
import { PostgresDialect } from "./postgres";

const postgres = new PostgresDialect();

/**
 * The array parameter behind `= any($1)`.
 *
 * Bun's driver will not bind a JS array to that parameter at all — it fails
 * with `insufficient data left in message` for numbers and `malformed array
 * literal` for strings — so the values are serialized to Postgres' own array
 * literal text. It is still one bound parameter and still nothing in the SQL
 * text, but the escaping is now ours to get right, which is what these pin.
 *
 * Every case below was also run against a real Postgres 16, selecting rows back
 * out through `= any($1)` on a column of the matching type. Unit tests can only
 * say the string is the one we meant; the database is what says it is the one
 * Postgres meant.
 */
function literal(values: unknown[]): unknown {
  const fragment = postgres.inList('"x"', false, values.length, () => values);
  return fragment.binders[0](undefined);
}

describe("in-list array literals", () => {
  test("numbers are quoted, and Postgres casts them back", () => {
    expect(literal([1, 2, 3])).toBe('{"1","2","3"}');
  });

  test("strings are quoted and escaped", () => {
    expect(literal(["plain"])).toBe('{"plain"}');
    // The four characters the array literal grammar cares about: the quote and
    // the backslash need escaping; the comma and the braces are inert once the
    // element is quoted.
    expect(literal([`wei"rd,{}\\ x`])).toBe('{"wei\\"rd,{}\\\\ x"}');
  });

  test("null is the one element that cannot be quoted", () => {
    // `"NULL"` is the four-character string; `NULL` is the null element.
    expect(literal([null, "NULL"])).toBe('{NULL,"NULL"}');
  });

  test("dates keep their UTC wall clock", () => {
    expect(literal([new Date(1600000000123)])).toBe(
      '{"2020-09-13T12:26:40.123Z"}',
    );
  });

  test("bigints keep every digit", () => {
    // Past 2^53, so a detour through `number` would be visible here.
    expect(literal([9007199254740993n])).toBe('{"9007199254740993"}');
  });

  test("bytes are hex, with the backslash doubled for the array parser", () => {
    expect(literal([new Uint8Array([0, 1, 255, 16])])).toBe(
      '{"\\\\x0001ff10"}',
    );
  });

  test("booleans", () => {
    expect(literal([true, false])).toBe('{"true","false"}');
  });

  test("an empty list", () => {
    // Unreachable through `where` — an empty `in` compiles to a constant-false
    // predicate before it gets here — but the batched relation loader builds
    // lists too, so this should be a valid literal rather than a crash.
    expect(literal([])).toBe("{}");
  });
});

describe("the text is still one parameter, whatever the length", () => {
  test.each([[1], [5], [100]])("%i values", (count) => {
    const args = {
      where: { id: { in: Array.from({ length: count }, (_, i) => i) } },
    };
    const plan = compileRead(user, "findMany", args, postgres);
    expect(plan.text).toContain('"id" = any ($1)');
    expect(plan.bind(args)).toHaveLength(1);
  });
});
