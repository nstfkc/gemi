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

/**
 * The shapes below are copied from a live Postgres 16 through Bun 1.3.14, not
 * from the Postgres manual — because the manual would have told you the
 * SQLSTATE is on `code`, and Bun puts its *own* code there and the SQLSTATE on
 * `errno`. Matching only `code` silently recognised nothing at all, and every
 * unique violation escaped as a raw driver error until a real database was
 * pointed at the suite.
 */
describe("constraint violations", () => {
  const violation = {
    name: "PostgresError",
    message: `duplicate key value violates unique constraint "User_email_key"`,
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "23505",
    detail: "Key (email)=(ada@example.dev) already exists.",
    constraint: "User_email_key",
    table: "User",
  };

  test("a duplicate key is recognised through errno", () => {
    expect(postgres.constraintViolation(violation)).toEqual({
      kind: "unique",
      columns: ["email"],
      constraint: "User_email_key",
    });
  });

  test("a driver that puts the SQLSTATE on code is recognised too", () => {
    expect(
      postgres.constraintViolation({ ...violation, errno: undefined, code: "23505" }),
    ).toMatchObject({ kind: "unique", columns: ["email"] });
  });

  test("a composite key reports every column", () => {
    expect(
      postgres.constraintViolation({
        ...violation,
        detail: "Key (username, provider)=(ada, github) already exists.",
        constraint: "SocialAccount_username_provider_key",
      }),
    ).toEqual({
      kind: "unique",
      columns: ["username", "provider"],
      constraint: "SocialAccount_username_provider_key",
    });
  });

  // The whole point of matching five characters rather than the `23` class:
  // these are integrity violations too, and reporting one as a duplicate key
  // sends the caller looking for a row that does not exist.
  test.each([
    ["not null", "23502"],
    ["foreign key", "23503"],
    ["check", "23514"],
    ["exclusion", "23P01"],
  ])("a %s violation is not a unique violation", (_name, errno) => {
    expect(postgres.constraintViolation({ ...violation, errno })).toBeNull();
  });

  test("anything else is left alone", () => {
    expect(postgres.constraintViolation(new Error("connection refused"))).toBeNull();
    expect(postgres.constraintViolation(null)).toBeNull();
    expect(postgres.constraintViolation(undefined)).toBeNull();
  });

  // Postgres localises `detail`, so on a server with lc_messages set to
  // anything but English the column list is unparseable. Degrading to a typed
  // violation with no columns beats inventing a wrong one.
  test("an unparseable detail still reports the constraint", () => {
    expect(
      postgres.constraintViolation({ ...violation, detail: "Schlüssel …" }),
    ).toEqual({
      kind: "unique",
      columns: [],
      constraint: "User_email_key",
    });
  });
});

describe("decoding the types the template schema cannot reach", () => {
  const field = (type: any) => ({
    name: "x", column: "x", type, nullable: true, isId: false, isUpdatedAt: false,
  });

  // Read off a live server: bigint arrives as a string and jsonb as unparsed
  // text, where Prisma returns a BigInt and an object. Everything else Bun
  // already decodes to what Prisma returns.
  test("bigint arrives as a string and becomes a BigInt", () => {
    expect(postgres.needsDecode(field("BigInt") as any)).toBe(true);
    expect(postgres.decode("9007199254740993", field("BigInt") as any)).toBe(
      9007199254740993n,
    );
  });

  /**
   * Bun parses `json` and `jsonb`, so decoding is a pass-through — and it has
   * to be. This used to re-parse anything that was a string, which cannot work:
   * a JS string is ambiguous between "raw JSON text" and "a JSON string value",
   * so the guard turned a column holding `"42"` into the number 42.
   */
  test("json arrives parsed, and is passed through untouched", () => {
    expect(postgres.decode({ a: [1, 2] }, field("Json") as any)).toEqual({
      a: [1, 2],
    });
    // The shapes that broke: a JSON string, and one whose contents are
    // themselves valid JSON.
    expect(postgres.decode("42", field("Json") as any)).toBe("42");
    expect(postgres.decode("true", field("Json") as any)).toBe("true");
    expect(postgres.decode('{"a":1}', field("Json") as any)).toBe('{"a":1}');
    // ...and the ones that always worked.
    expect(postgres.decode("text", field("Json") as any)).toBe("text");
    expect(postgres.decode(42, field("Json") as any)).toBe(42);
    expect(postgres.decode([], field("Json") as any)).toEqual([]);
  });

  /**
   * `needsDecode` stays true even though `decode` is now a pass-through for
   * `Json`: it is asked per *field type*, and the shaper skips the call
   * entirely when it is false. Flipping it would be a micro-optimisation that
   * silently stops `null` becoming `null`.
   */
  test("Json still reports that it needs decoding", () => {
    expect(postgres.needsDecode(field("Json") as any)).toBe(true);
  });

  test.each(["Int", "String", "Boolean", "Float", "DateTime"])(
    "%s needs no decoding",
    (type) => {
      expect(postgres.needsDecode(field(type) as any)).toBe(false);
    },
  );

  /**
   * `Bytes` used to be on that list, and the driver's `Buffer` went straight
   * through. Prisma 6 returns a `Uint8Array` on every dialect, and so does this
   * ORM on SQLite, where the driver's own value already is one — so passing the
   * `Buffer` through diverged from Prisma and from our other dialect at once.
   *
   * It stayed invisible because `Buffer` *is* a `Uint8Array`: it satisfies the
   * generated type, passes `ArrayBuffer.isView`, and compares equal element by
   * element. `toString` is where they part company.
   */
  test("Bytes is normalised to a Uint8Array, not the driver's Buffer", () => {
    expect(postgres.needsDecode(field("Bytes") as any)).toBe(true);

    const buffer = Buffer.from([1, 2, 255]);
    const decoded = postgres.decode(buffer, field("Bytes") as any) as Uint8Array;

    expect(Buffer.isBuffer(decoded)).toBe(false);
    expect(decoded.constructor.name).toBe("Uint8Array");
    expect([...decoded]).toEqual([1, 2, 255]);

    // The observable difference, and the reason the container is worth a test:
    // `Buffer.prototype.toString` takes an encoding, `Uint8Array`'s ignores it.
    expect(buffer.toString("hex")).toBe("0102ff");
    expect(decoded.toString("hex")).toBe("1,2,255");
  });

  /** A view over the driver's bytes, so a large row costs no copy. */
  test("the normalised Bytes shares memory with the driver's buffer", () => {
    const buffer = Buffer.from([7, 8, 9]);
    const decoded = postgres.decode(buffer, field("Bytes") as any) as Uint8Array;

    expect(decoded.buffer).toBe(buffer.buffer);
    expect(decoded.byteOffset).toBe(buffer.byteOffset);
  });

  /** A driver that already hands back a plain view is left alone. */
  test("a Uint8Array from the driver passes through untouched", () => {
    const bytes = new Uint8Array([4, 5]);
    expect(postgres.decode(bytes, field("Bytes") as any)).toBe(bytes);
  });

  /**
   * `Json` is no longer in this set, and cannot be: every value the driver
   * hands back is already a parsed JSON value, so there is nothing left that
   * *could* fail to decode. It used to raise for a string that would not parse
   * — which, after the fix, is simply a JSON string.
   */
  test("a value that cannot be decoded raises rather than returning nonsense", () => {
    expect(() => postgres.decode("3.5", field("BigInt") as any)).toThrow();
    expect(postgres.decode("not json", field("Json") as any)).toBe("not json");
  });

  test("null stays null", () => {
    expect(postgres.decode(null, field("Json") as any)).toBeNull();
    expect(postgres.decode(undefined, field("BigInt") as any)).toBeNull();
  });
});
