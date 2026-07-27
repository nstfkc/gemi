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

  test("Json is serialised", () => {
    expect(sqlite.encode({ a: 1 }, field("Json"))).toBe('{"a":1}');
    expect(sqlite.encode('{"a":1}', field("Json"))).toBe('{"a":1}');
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
