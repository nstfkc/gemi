import { describe, expect, test } from "vitest";

import type { FieldSchema } from "../schema";
import { SqliteDialect } from "./sqlite";

const sqlite = new SqliteDialect();

function field(
  type: FieldSchema["type"],
  overrides: Partial<FieldSchema> = {},
): FieldSchema {
  return {
    name: "value",
    column: "value",
    type,
    nullable: true,
    isId: false,
    isUpdatedAt: false,
    ...overrides,
  };
}

describe("identifiers and placeholders", () => {
  test("quotes with double quotes", () => {
    expect(sqlite.quoteIdent("User")).toBe('"User"');
    expect(sqlite.quoteIdent("is_archived")).toBe('"is_archived"');
  });

  test("escapes an embedded quote", () => {
    expect(sqlite.quoteIdent('we"ird')).toBe('"we""ird"');
  });

  // NUL is the parameter sentinel in compile/fragment.ts, so it is the one
  // character that could shift a placeholder's position rather than merely
  // produce broken SQL. Unreachable from a generated schema — asserted anyway,
  // so the invariant is unconditional rather than argued.
  test("refuses an identifier containing the parameter sentinel", () => {
    expect(() => sqlite.quoteIdent("id\u0000")).toThrow(/NUL byte/);
  });

  // Verified against Bun's `SQL.unsafe` rather than assumed: Postgres will be
  // `$1`, and the whole dialect abstraction depends on getting this right.
  test("uses positional ? regardless of index", () => {
    expect(sqlite.placeholder(0)).toBe("?");
    expect(sqlite.placeholder(7)).toBe("?");
  });
});

// SQLite has neither a DateTime nor a Boolean storage class. Prisma writes
// DateTime as integer milliseconds and Boolean as 0/1, so handing the driver's
// values straight back would diverge from Prisma's result shape on the
// template's very first `createdAt`.
describe("decode()", () => {
  test("integer milliseconds become a Date", () => {
    const decoded = sqlite.decode(1772093271771, field("DateTime"));
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).toISOString()).toBe("2026-02-26T08:07:51.771Z");
  });

  // A row written by a migration default (`CURRENT_TIMESTAMP`) rather than by
  // Prisma holds text. SQLite documents that text as UTC; `new Date()` would
  // otherwise read it as local time and shift it by the machine's offset.
  test("a naked SQLite timestamp is read as UTC, not local time", () => {
    const decoded = sqlite.decode("2026-02-26 08:07:51", field("DateTime"));
    expect((decoded as Date).toISOString()).toBe("2026-02-26T08:07:51.000Z");
  });

  test("an ISO string with a zone is left alone", () => {
    const decoded = sqlite.decode("2026-02-26T08:07:51.771Z", field("DateTime"));
    expect((decoded as Date).toISOString()).toBe("2026-02-26T08:07:51.771Z");
  });

  test("0 and 1 become booleans", () => {
    expect(sqlite.decode(0, field("Boolean"))).toBe(false);
    expect(sqlite.decode(1, field("Boolean"))).toBe(true);
  });

  test("BigInt columns come back as bigints", () => {
    expect(sqlite.decode(9007199254740993n, field("BigInt"))).toBe(
      9007199254740993n,
    );
    expect(sqlite.decode(42, field("BigInt"))).toBe(42n);
  });

  test("Json columns are parsed", () => {
    expect(sqlite.decode('{"a":1}', field("Json"))).toEqual({ a: 1 });
  });

  test.each(["DateTime", "Boolean", "Json", "BigInt", "String", "Int"] as const)(
    "%s: null stays null",
    (type) => {
      expect(sqlite.decode(null, field(type))).toBe(null);
    },
  );

  test("scalars the driver already returns correctly pass through", () => {
    expect(sqlite.decode("hello", field("String"))).toBe("hello");
    expect(sqlite.decode(3, field("Int"))).toBe(3);
    expect(sqlite.decode(1.5, field("Float"))).toBe(1.5);
  });

  // Bun returns a SQLite BLOB as a Uint8Array, which is exactly what Prisma 6
  // returns for `Bytes`. Verified against the driver rather than assumed, since
  // the pass-through path is otherwise silent about whether it is correct.
  test("Bytes passes through as the Uint8Array Prisma returns", () => {
    const bytes = new Uint8Array([1, 2, 255]);
    expect(sqlite.decode(bytes, field("Bytes"))).toBe(bytes);
    expect(sqlite.needsDecode(field("Bytes"))).toBe(false);
  });

  // A column holding something the schema says it cannot must fail loudly. An
  // `Invalid Date` or a truncated bigint would be a wrong answer instead.
  describe("refuses a value that contradicts the schema", () => {
    test("an unparseable DateTime, rather than returning an Invalid Date", () => {
      expect(() => sqlite.decode("not a date", field("DateTime"))).toThrow(
        /Could not decode/,
      );
      expect(() => sqlite.decode({}, field("DateTime"))).toThrow(
        /Could not decode/,
      );
    });

    test("a fractional BigInt, naming the column", () => {
      expect(() =>
        sqlite.decode(3.5, field("BigInt", { column: "size" })),
      ).toThrow(/'size'/);
    });

    test("malformed Json", () => {
      expect(() => sqlite.decode("{not json", field("Json"))).toThrow(
        /Could not decode/,
      );
    });
  });

  // `0n !== 0` is true, so a strict comparison would decode a bigint zero as
  // `true`. Latent today — Bun returns numbers for SQLite integers — but free
  // to close.
  test("a bigint zero decodes to false, not true", () => {
    expect(sqlite.decode(0n, field("Boolean"))).toBe(false);
    expect(sqlite.decode(1n, field("Boolean"))).toBe(true);
  });
});

// The mirror of decode, and the one that silently breaks a query rather than
// failing it: Bun's SQLite driver binds a `Date` object to NULL, so an
// unencoded `where: { createdAt: date }` returns no rows at all.
describe("encode()", () => {
  test("a Date becomes integer milliseconds, the way Prisma stores it", () => {
    expect(
      sqlite.encode(new Date(1772093271771), field("DateTime")),
    ).toBe(1772093271771);
  });

  test("a DateTime already given as a number is left alone", () => {
    expect(sqlite.encode(1772093271771, field("DateTime"))).toBe(1772093271771);
  });

  test("booleans become 0 and 1", () => {
    expect(sqlite.encode(true, field("Boolean"))).toBe(1);
    expect(sqlite.encode(false, field("Boolean"))).toBe(0);
  });

  /**
   * Serialised unconditionally. The `typeof value === "string" ? value : …`
   * guard this used to carry could not tell "already JSON text" from "a JSON
   * string value", so a field set to `"42"` was stored as the text `42` and
   * decoded back as the *number* 42.
   */
  test("Json is serialised, including when it is already a string", () => {
    expect(sqlite.encode({ a: 1 }, field("Json"))).toBe('{"a":1}');
    // The shapes that broke: quoting is what makes them survive `JSON.parse`.
    expect(sqlite.encode("42", field("Json"))).toBe('"42"');
    // A string whose *contents* are JSON is still a string, and comes back as
    // one — the case the old guard silently turned into an object.
    expect(sqlite.encode('{"a":1}', field("Json"))).toBe(
      JSON.stringify('{"a":1}'),
    );
    expect(sqlite.encode("text", field("Json"))).toBe('"text"');
    // ...and they round-trip through the decoder beside it.
    for (const value of [{ a: 1 }, "42", "text", [1, 2], null]) {
      const stored = sqlite.encode(value, field("Json"));
      expect(sqlite.decode(stored, field("Json"))).toEqual(value);
    }
  });

  test("scalars the driver already binds correctly pass through", () => {
    expect(sqlite.encode("hello", field("String"))).toBe("hello");
    expect(sqlite.encode(3, field("Int"))).toBe(3);
    expect(sqlite.encode(1.5, field("Float"))).toBe(1.5);
  });

  test.each(["DateTime", "Boolean", "Json", "String", "Int"] as const)(
    "%s: null stays null",
    (type) => {
      expect(sqlite.encode(null, field(type))).toBe(null);
    },
  );

  // Round-tripping is the property that actually matters.
  test("encode then decode returns the original value", () => {
    const date = new Date(1772093271771);
    expect(
      sqlite.decode(sqlite.encode(date, field("DateTime")), field("DateTime")),
    ).toEqual(date);
    expect(
      sqlite.decode(sqlite.encode(true, field("Boolean")), field("Boolean")),
    ).toBe(true);
    expect(
      sqlite.decode(sqlite.encode({ a: 1 }, field("Json")), field("Json")),
    ).toEqual({ a: 1 });
  });
});

describe("needsDecode()", () => {
  // The shaper skips the call entirely for these, which is why it is a separate
  // question from `decode` itself.
  test.each(["DateTime", "Boolean", "BigInt", "Json"] as const)(
    "%s needs decoding",
    (type) => {
      expect(sqlite.needsDecode(field(type))).toBe(true);
    },
  );

  test.each(["String", "Int", "Float", "Decimal", "Bytes"] as const)(
    "%s does not",
    (type) => {
      expect(sqlite.needsDecode(field(type))).toBe(false);
    },
  );
});

/**
 * The shapes below are copied from Bun 1.3.14's bundled SQLite 3.51.0, not from
 * the SQLite docs. Every constraint failure is the same `SQLiteError` type and
 * only `code` distinguishes them, which is why matching on the message would
 * report a NOT NULL failure as a duplicate key.
 */
describe("constraint violations", () => {
  const violation = {
    name: "SQLiteError",
    message: "UNIQUE constraint failed: User.email",
    code: "SQLITE_CONSTRAINT_UNIQUE",
    errno: 2067,
  };

  test("a duplicate key reports its column, without the table", () => {
    expect(sqlite.constraintViolation(violation)).toEqual({
      kind: "unique",
      columns: ["email"],
    });
  });

  test("a composite key reports every column", () => {
    expect(
      sqlite.constraintViolation({
        ...violation,
        message: "UNIQUE constraint failed: SocialAccount.username, SocialAccount.provider",
      }),
    ).toEqual({ kind: "unique", columns: ["username", "provider"] });
  });

  test("a primary-key collision counts as a unique violation", () => {
    expect(
      sqlite.constraintViolation({
        ...violation,
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        message: "UNIQUE constraint failed: User.id",
      }),
    ).toEqual({ kind: "unique", columns: ["id"] });
  });

  // The reason `code` is what is matched on.
  test.each([
    ["not null", "SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed: User.publicId"],
    ["foreign key", "SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed"],
    ["check", "SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: User"],
  ])("a %s violation is not a unique violation", (_name, code, message) => {
    expect(sqlite.constraintViolation({ ...violation, code, message })).toBeNull();
  });

  test("anything else is left alone", () => {
    expect(sqlite.constraintViolation(new Error("database is locked"))).toBeNull();
    expect(sqlite.constraintViolation(null)).toBeNull();
    expect(sqlite.constraintViolation(undefined)).toBeNull();
  });

  // A column name may itself contain a dot, so only the first one separates
  // the table from the column.
  test("only the first dot separates table from column", () => {
    expect(
      sqlite.constraintViolation({
        ...violation,
        message: "UNIQUE constraint failed: User.odd.name",
      }),
    ).toEqual({ kind: "unique", columns: ["odd.name"] });
  });

  test("a message it cannot parse still reports a violation", () => {
    expect(
      sqlite.constraintViolation({ ...violation, message: "UNIQUE failed somehow" }),
    ).toEqual({ kind: "unique", columns: [] });
  });
});
