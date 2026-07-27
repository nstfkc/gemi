import { describe, expect, test } from "vitest";

import { SqliteDialect } from "./dialect/sqlite";
import { mapped, user } from "./fixtures";
import { buildRowShaper } from "./shape";

const sqlite = new SqliteDialect();

describe("buildRowShaper()", () => {
  test("maps columns to field names", () => {
    const shape = buildRowShaper(Object.values(mapped.fields), sqlite);

    const rows = shape([
      {
        id: 1,
        is_archived: 1,
        occurred_at: 1772093271771,
        payload: '{"a":1}',
        size: 12,
      },
    ]);

    expect(rows).toEqual([
      {
        id: 1,
        isArchived: true,
        occurredAt: new Date(1772093271771),
        payload: { a: 1 },
        size: 12n,
      },
    ]);
  });

  test("emits keys in schema order, so the result shape is stable", () => {
    const shape = buildRowShaper(Object.values(user.fields), sqlite);
    const [row] = shape([{ email: "a@b.c", id: 1 }]);
    expect(Object.keys(row)).toEqual(Object.keys(user.fields));
  });

  test("a missing column reads as null, never undefined", () => {
    const shape = buildRowShaper(Object.values(mapped.fields), sqlite);
    const [row] = shape([{ id: 1 }]);

    expect(row.payload).toBe(null);
    expect(row.occurredAt).toBe(null);
    // `is_archived` is not nullable in the schema, but a decoder must not
    // invent `false` out of a value the driver never returned.
    expect(row.isArchived).toBe(null);
  });

  test("handles an empty result set", () => {
    const shape = buildRowShaper(Object.values(user.fields), sqlite);
    expect(shape([])).toEqual([]);
  });

  test("shapes every row", () => {
    const shape = buildRowShaper(Object.values(mapped.fields), sqlite);
    const rows = shape([
      { id: 1, is_archived: 0, occurred_at: 0 },
      { id: 2, is_archived: 1, occurred_at: 1000 },
    ]);

    expect(rows.map((row) => row.isArchived)).toEqual([false, true]);
    expect(rows).toHaveLength(2);
  });
});
