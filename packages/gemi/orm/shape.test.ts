import { afterEach, describe, expect, test } from "vitest";


import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { mapped, reading, user } from "./fixtures";
import type { FieldSchema } from "./schema";
import {
  buildInterpretedShaper,
  buildRowShaper,
  setShaperCompilation,
  shaperCompilationAvailable,
  type RowShaper,
  type ShapedRelation,
} from "./shape";

const sqlite = new SqliteDialect();

afterEach(() => {
  setShaperCompilation(true);
});

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

/**
 * The two shapers must produce identical output.
 *
 * Iteration 7 made the default a generated function body — 3.4× faster on a
 * 1000-row read, measured. The interpreted one stays as the fallback for
 * runtimes that refuse `new Function` (a strict CSP, some edge runtimes), which
 * means there are now two code paths producing the caller's result, and a
 * divergence between them would appear only on whichever runtime the author was
 * not using.
 *
 * So this suite's job is not "does shaping work" — the cases above and the
 * differential harness cover that. It is: **do the two implementations agree**,
 * across fixtures, dialects, and relation shapes. It is what makes having two
 * paths acceptable.
 */
describe("compiled and interpreted shapers agree", () => {
  const postgres = new PostgresDialect();

  test("compilation is actually available here", () => {
    // If this were ever false, every case below would be comparing the
    // interpreted shaper against itself — passing while proving nothing.
    expect(shaperCompilationAvailable()).toBe(true);
  });

  const cases: Array<[string, any, any, Record<string, unknown>[]]> = [
    [
      "user, sqlite",
      user,
      sqlite,
      [{ id: 1, email: "a@b.c", createdAt: 1_700_000_000_000, globalRole: 2 }],
    ],
    [
      "user, postgres",
      user,
      postgres,
      [{ id: 1, email: "a@b.c", createdAt: new Date("2024-01-01T00:00:00Z") }],
    ],
    // `@map` / `@@map`: the output key and the driver column differ, which is
    // the one thing a naive `{ ...row }` would get wrong.
    [
      "mapped columns, sqlite",
      mapped,
      sqlite,
      [
        {
          id: 1,
          is_archived: 1,
          occurred_at: 1_700_000_000_000,
          payload: '{"a":1}',
          size: 12,
        },
      ],
    ],
    [
      "mapped columns, postgres",
      mapped,
      postgres,
      [
        {
          id: 1,
          is_archived: true,
          occurred_at: new Date("2024-01-01T00:00:00Z"),
          payload: '{"a":1}',
          size: "9007199254740993",
        },
      ],
    ],
    // Bytes and a DateTime, where the dialects encode differently — so a decode
    // branch emitted into the generated source could be wrong on one only.
    [
      "reading with bytes, postgres",
      reading,
      postgres,
      [
        {
          id: 1,
          at: new Date("2024-06-01T00:00:00Z"),
          digest: new Uint8Array([1, 2, 3]),
          value: 1.5,
        },
      ],
    ],
    // ...and the same shape on sqlite, where `Bytes` has no decode branch at
    // all and falls through. The table covered it on postgres only, so a
    // divergence confined to the passthrough side would not have shown.
    [
      "reading with bytes, sqlite",
      reading,
      sqlite,
      [
        {
          id: 1,
          at: 1_717_200_000_000,
          digest: new Uint8Array([1, 2, 3]),
          value: 1.5,
        },
      ],
    ],
    ["a row missing every optional column", user, sqlite, [{ id: 1 }]],
    ["no rows at all", user, sqlite, []],
  ];

  test.each(cases)("%s", (_label, schema, dialect, rows) => {
    const fields = Object.values(schema.fields) as any[];
    const compiled = buildRowShaper(fields, dialect);
    const interpreted = buildInterpretedShaper(fields, dialect);

    expect(compiled(rows)).toEqual(interpreted(rows));
    // The JSON form also pins key *order*, which is observable to a caller and
    // which a deep-equal would not catch.
    expect(JSON.stringify(compiled(rows), stable)).toBe(
      JSON.stringify(interpreted(rows), stable),
    );
  });

  /**
   * **The two shapers have to fail alike, not only succeed alike.**
   *
   * The table above compares output, which says nothing about a row the
   * decoders refuse. `DecodeError` is raised from inside `dialect.decode`, and
   * the compiled shaper *inlines* what the interpreted one calls — so a
   * divergence here would be one path throwing while the other returned
   * something plausible, on exactly the malformed input that made it matter.
   *
   * That is the same lesson the differential harness already carries: it
   * compares failure *kind* rather than only values, because two clients that
   * agree when things work and disagree when they do not have not been shown
   * to agree.
   *
   * All three decoders that can refuse are covered on both dialects — `BigInt`
   * (`BigInt(3.5)` throws a RangeError), `Json` (unparseable), and `DateTime`.
   */
  describe("both shapers fail alike", () => {
    const outcome = (shaper: RowShaper, rows: unknown[]) => {
      try {
        return {
          threw: false,
          value: JSON.stringify(shaper(rows), (_key, value) =>
            typeof value === "bigint" ? `${value}n` : value,
          ),
        };
      } catch (error) {
        return { threw: true, value: (error as Error).constructor.name };
      }
    };

    test.each([
      ["a BigInt that is not an integer", "sqlite", sqlite, { size: 3.5 }],
      ["a BigInt that is not an integer", "postgres", postgres, { size: 3.5 }],
      ["a Json that will not parse", "sqlite", sqlite, { payload: "{not json" }],
      ["a Json that will not parse", "postgres", postgres, { payload: "{not json" }],
      ["a DateTime that is not one", "sqlite", sqlite, { occurred_at: "not a date" }],
      ["a DateTime that is not one", "postgres", postgres, { occurred_at: "not a date" }],
    ])("%s, %s", (_label, _dialectName, dialect, bad) => {
      const fields = Object.values(mapped.fields) as FieldSchema[];
      const rows = [{ id: 1, ...bad }];

      const compiled = outcome(buildRowShaper(fields, dialect), rows);
      const interpreted = outcome(buildInterpretedShaper(fields, dialect), rows);

      expect(compiled).toEqual(interpreted);
    });
  });

  const relations: ShapedRelation[] = [
    { key: "accounts", kind: "many" },
    { key: "organization", kind: "one" },
  ];

  test("empty to-many is [] and empty to-one is null, in both", () => {
    const fields = Object.values(user.fields);
    for (const shaper of [
      buildRowShaper(fields, sqlite, relations),
      buildInterpretedShaper(fields, sqlite, relations),
    ]) {
      const [row] = shaper([{ id: 1 }]);
      expect(row.accounts).toEqual([]);
      expect(row.organization).toBeNull();
    }
  });

  /**
   * The aliasing hazard, asserted for both paths.
   *
   * The relation loader *pushes into* these arrays, so two rows sharing one
   * would give every parent every child. The interpreted path allocates per row
   * explicitly; the compiled path gets it from having the literal inside the
   * loop. Neither claim is worth trusting without this.
   */
  test("each row gets its own relation array in both", () => {
    const fields = Object.values(user.fields);
    for (const shaper of [
      buildRowShaper(fields, sqlite, relations),
      buildInterpretedShaper(fields, sqlite, relations),
    ]) {
      const shaped = shaper([{ id: 1 }, { id: 2 }]);
      expect(shaped[0].accounts).not.toBe(shaped[1].accounts);
      (shaped[0].accounts as unknown[]).push("x");
      expect(shaped[1].accounts).toEqual([]);
    }
  });

  test("relation keys land after the scalars in both", () => {
    const fields = Object.values(user.fields);
    expect(
      Object.keys(buildRowShaper(fields, sqlite, relations)([{ id: 1 }])[0]),
    ).toEqual(
      Object.keys(
        buildInterpretedShaper(fields, sqlite, relations)([{ id: 1 }])[0],
      ),
    );
  });

  test("setShaperCompilation(false) selects the interpreted one, same output", () => {
    const fields = Object.values(user.fields);
    const rows = [{ id: 1, email: "a@b.c" }];

    setShaperCompilation(false);
    const off = buildRowShaper(fields, sqlite);
    setShaperCompilation(true);
    const on = buildRowShaper(fields, sqlite);

    // The switch is a performance knob, never a behaviour one — which is the
    // property that makes it safe to flip.
    expect(off(rows)).toEqual(on(rows));
    // ...and they are genuinely different functions, or this asserts nothing.
    expect(off.toString()).not.toBe(on.toString());
  });
});

/** BigInt and Uint8Array are not JSON-serialisable; both need a stable form. */
function stable(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value instanceof Uint8Array) return `bytes:${[...value].join(",")}`;
  return value;
}
