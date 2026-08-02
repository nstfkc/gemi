import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDifferential, type Differential } from "./differential";
import { POSTGRES_LISTS_URL } from "./scratch";

/**
 * Scalar lists — `tags String[]` — against Prisma, on a real Postgres (#300).
 *
 * **The schema is a second one, and that decision came before the compiler.**
 * A scalar list is legal on Postgres and a validation error on SQLite, and
 * `app/models/postgres.sh` covers both dialects by flipping the provider in one
 * `schema.prisma`. So the column cannot live there: it would not merely go
 * untested on SQLite, it would stop every SQLite suite from generating.
 * `prisma/postgres-only.prisma` carries it instead, with its own client and its
 * own database, which is what keeps the property the rest of this ORM's
 * correctness rests on — the same query through both clients, compared on rows
 * *and* on table contents.
 *
 * The cheaper options were considered and are weaker in a way worth recording:
 * asserting against Prisma's documented shape checks gemi against a reading of
 * the docs, and a hand-built table with raw SQL gives a real round trip with no
 * oracle at all. Both would have missed the two defects this file actually
 * found — see the `documents` cases, where a wrong cast answers *false* rather
 * than raising, and the `bigints` case behind a relation.
 *
 * **Everything is imported dynamically.** `app/models/generated-lists/` is
 * gitignored and only exists after `prisma generate --schema
 * prisma/postgres-only.prisma`, so a static import would fail this file's
 * *collection* during a SQLite run — which takes the whole file out of the
 * totals rather than skipping it, the failure mode
 * `template-import-graph.test.ts` documents at length.
 */
const RUN = POSTGRES_LISTS_URL ? describe : describe.skip;

/**
 * Both halves of the established idiom, because each buys something different.
 *
 * `RUN` is the `POSTGRES…_URL ? describe : describe.skip` shape that
 * `packages/gemi/orm/postgres-suite-selection.test.ts` looks for — which is
 * what makes it check that this suite's *name* contains `postgres`, since the
 * CI job's `-t postgres` filter is what selects it. Without that, a file can be
 * run by neither job and nothing says so; three files were in that position.
 *
 * The passing test below is the announcement. `describe.skip` is silent, and a
 * silently skipped dialect reads as a passing one — so the absence is reported
 * where a person scanning CI output will see it. The wording is deliberately
 * the same as the four suites that already do this.
 */
if (!POSTGRES_LISTS_URL) {
  describe("scalar lists vs prisma — postgres (skipped)", () => {
    test("SKIPPED — set TEST_POSTGRES_LISTS_URL to cover scalar lists", () => {
      console.warn(
        "\n  ⚠  Scalar-list differential tests did NOT run.\n" +
          "     They need the second schema: app/models/postgres.sh pushes " +
          "prisma/postgres-only.prisma\n" +
          "     to its own database and sets TEST_POSTGRES_LISTS_URL.\n",
      );
      expect(POSTGRES_LISTS_URL).toBeUndefined();
    });
  });
}

/**
 * One row's worth of every element type Prisma allows in a list on Postgres.
 *
 * Chosen so a wrong answer is visible rather than plausible: a string holding
 * every delimiter the Postgres array literal uses, a bigint past 2^53, a JSON
 * value that is legitimately a *string*, and an empty list beside a populated
 * one so `isEmpty` has something to be wrong about.
 */
const SEEDS = [
  {
    id: 1,
    strings: ["alpha", 'has "quote", brace } and \\ backslash', ""],
    ints: [1, 2, 3],
    floats: [1.5, -2.25],
    booleans: [true, false],
    bigints: [9007199254740993n, 2n],
    stamps: [new Date("2024-01-02T03:04:05.678Z")],
    blobs: [new Uint8Array([1, 2, 255])],
    documents: [{ a: 1 }, [1, 2], "42", 7, null],
    labels: ["urgent" as const, "needs_review" as const],
    renamed: ["mapped"],
  },
  {
    id: 2,
    strings: ["alpha", "beta"],
    ints: [3],
    floats: [],
    booleans: [],
    bigints: [],
    stamps: [],
    blobs: [],
    documents: [],
    labels: ["blocked" as const],
    renamed: [],
  },
  {
    id: 3,
    strings: [],
    ints: [],
    floats: [],
    booleans: [],
    bigints: [],
    stamps: [],
    blobs: [],
    documents: [],
    labels: [],
    renamed: [],
  },
];

RUN("scalar lists vs prisma — postgres", () => {
  let differential: Differential;
  let models: Record<string, any>;

  beforeAll(async () => {
    // Non-literal specifiers: `tsc` cannot resolve them and so does not try,
    // which is the point — these paths do not exist during a SQLite run.
    const generated = "./generated-lists";
    const clientModule = "./generated-lists/client";

    const [{ TaggedModel, NoteModel }, { PrismaClient }] = await Promise.all([
      import(/* @vite-ignore */ generated),
      import(/* @vite-ignore */ clientModule),
    ]);

    models = { Tagged: TaggedModel, Note: NoteModel };

    differential = await createDifferential({
      models,
      url: POSTGRES_LISTS_URL,
      client: new PrismaClient({
        datasources: { db: { url: POSTGRES_LISTS_URL } },
      }),
      // Children before parents.
      tables: ["Note", "Tagged"],
      seed: async (prisma: any) => {
        for (const row of SEEDS) {
          await prisma.tagged.create({ data: row });
        }
        await prisma.note.create({
          data: {
            taggedId: 1,
            keywords: ["one", "two"],
            counts: [4, 5],
            amounts: [9007199254740993n],
            when: [new Date("2024-03-04T05:06:07.008Z")],
          },
        });
      },
    });
  }, 180_000);

  afterAll(async () => {
    await differential?.dispose();
  });

  // --- reading -------------------------------------------------------------

  /**
   * The decode path, per element type, in one comparison.
   *
   * This is the case the whole second schema exists for. `Int[]` arrives from
   * the driver as an `Int32Array`, `BigInt[]` as an array of *strings*,
   * `Bytes[]` as `Buffer`s, and an enum list as the **unparsed** literal
   * `{urgent,needs_review}` — four different containers, none of them what
   * Prisma returns, and `normalize` in the harness compares constructor names
   * so a `Buffer` where Prisma gives a `Uint8Array` fails rather than passing.
   */
  test("every element type decodes to what Prisma returns", async () => {
    await differential.expectSame("Tagged", "findMany", {
      orderBy: { id: "asc" },
    });
  });

  test("an empty list is [] rather than null", async () => {
    await differential.expectSame("Tagged", "findUnique", { where: { id: 3 } });
  });

  test("a mapped column is read through its field name", async () => {
    await differential.expectSame("Tagged", "findMany", {
      select: { id: true, renamed: true },
      orderBy: { id: "asc" },
    });
  });

  // --- filtering -----------------------------------------------------------

  const FILTERS: [string, unknown][] = [
    ["has", { strings: { has: "alpha" } }],
    ["has, absent", { strings: { has: "nope" } }],
    ["has, on the delimiter string", { strings: { has: 'has "quote", brace } and \\ backslash' } }],
    ["has, empty string", { strings: { has: "" } }],
    ["hasEvery", { strings: { hasEvery: ["alpha", "beta"] } }],
    ["hasEvery, empty", { strings: { hasEvery: [] } }],
    ["hasSome", { strings: { hasSome: ["beta", "nope"] } }],
    ["hasSome, empty", { strings: { hasSome: [] } }],
    ["isEmpty true", { strings: { isEmpty: true } }],
    ["isEmpty false", { strings: { isEmpty: false } }],
    ["equals", { strings: { equals: ["alpha", "beta"] } }],
    ["equals, order matters", { strings: { equals: ["beta", "alpha"] } }],
    ["equals, empty", { strings: { equals: [] } }],
    ["equals null", { strings: { equals: null } }],
    ["has null", { strings: { has: null } }],
    ["ints has", { ints: { has: 3 } }],
    ["ints hasEvery", { ints: { hasEvery: [1, 2] } }],
    ["floats has", { floats: { has: -2.25 } }],
    ["booleans has", { booleans: { has: false } }],
    ["bigints has", { bigints: { has: 9007199254740993n } }],
    ["stamps has", { stamps: { has: new Date("2024-01-02T03:04:05.678Z") } }],
    ["blobs has", { blobs: { has: new Uint8Array([1, 2, 255]) } }],
    ["labels has", { labels: { has: "needs_review" } }],
    ["labels hasSome", { labels: { hasSome: ["urgent", "blocked"] } }],
    ["renamed has", { renamed: { has: "mapped" } }],
    // The `Json[]` cases. `$1::jsonb = any(col)` answers *false* where
    // `$1::text::jsonb` answers true — no error on the wrong one — so these are
    // the cases a docs-shaped assertion could not have caught.
    ["documents has an object", { documents: { has: { a: 1 } } }],
    ["documents has an array", { documents: { has: [1, 2] } }],
    ["documents has a JSON string", { documents: { has: "42" } }],
    ["documents has a JSON number", { documents: { has: 7 } }],
    ["documents hasSome", { documents: { hasSome: [{ a: 1 }, { z: 9 }] } }],
    ["documents isEmpty", { documents: { isEmpty: true } }],
    // Combinators over a list filter, so it composes like any other predicate.
    ["AND of two list filters", { AND: [{ ints: { has: 3 } }, { strings: { has: "alpha" } }] }],
    ["NOT of a list filter", { NOT: { strings: { has: "alpha" } } }],
    ["OR of list filters", { OR: [{ ints: { has: 1 } }, { labels: { has: "blocked" } }] }],
  ];

  test.each(FILTERS)("filter: %s", async (_name, where) => {
    await differential.expectSame("Tagged", "findMany", {
      where,
      orderBy: { id: "asc" },
    });
  });

  test.each(FILTERS)("count: %s", async (_name, where) => {
    await differential.expectSame("Tagged", "count", { where });
  });

  // --- relations -----------------------------------------------------------

  /**
   * A list one relation down, which is a **second decoding site**: under the
   * lateral strategy the child arrives inside `json_agg`, where the driver's
   * type mapping never runs. `BigInt[]` is the one that fails silently there —
   * JSON has no integer type, so 9007199254740993 comes back as ...992 without
   * a `::text[]` cast.
   */
  test("a list inside an include, both strategies", async () => {
    for (const strategy of ["batched", "lateral"] as const) {
      await differential.expectSame(
        "Tagged",
        "findMany",
        { where: { id: 1 }, include: { notes: true } },
        { relationStrategy: strategy } as never,
      );
    }
  });

  test("a list filter through a relation", async () => {
    await differential.expectSame("Tagged", "findMany", {
      where: { notes: { some: { keywords: { has: "one" } } } },
      orderBy: { id: "asc" },
    });
  });

  // --- writing -------------------------------------------------------------

  test("create with a bare array", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "create",
      { data: { id: 10, strings: ["x", "y"], ints: [1] } },
      { tables: ["Tagged"] },
    );
  });

  test("create with { set }", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "create",
      { data: { id: 11, strings: { set: ["x", "y"] } } },
      { tables: ["Tagged"] },
    );
  });

  /**
   * **The case that found the divergence.** Every list but `strings` is absent
   * here, and every one of them is `NOT NULL` with no database default. gemi
   * refused the call — *"missing a value for 'ints', which is required and has
   * no default"* — and Prisma answered it, writing `[]` to all nine.
   *
   * No reading of Prisma's documentation produces this: the docs describe the
   * *input type*, where a list field is optional, and say nothing about what
   * gets written when it is omitted. Only running both clients against one
   * database does.
   */
  test("an omitted list is written as [], not refused", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "create",
      { data: { id: 12, strings: ["x"] } },
      { tables: ["Tagged"] },
    );
  });

  test("a list with @default([]) is left to the database", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "create",
      { data: { id: 16, strings: ["x"], defaulted: undefined } },
      { tables: ["Tagged"] },
    );
  });

  test("create with every element type", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "create",
      {
        data: {
          id: 13,
          strings: ["a"],
          ints: [1],
          floats: [0.5],
          booleans: [true],
          bigints: [9007199254740993n],
          stamps: [new Date("2020-06-07T08:09:10.011Z")],
          blobs: [new Uint8Array([9, 8])],
          documents: [{ b: 2 }, "text"],
          labels: ["needs_review"],
        },
      },
      { tables: ["Tagged"] },
    );
  });

  test("createMany mixing the bare and { set } spellings", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "createMany",
      {
        data: [
          { id: 14, strings: ["p"] },
          { id: 15, strings: { set: ["q", "r"] } },
        ],
      },
      { tables: ["Tagged"] },
    );
  });

  const WRITES: [string, unknown][] = [
    ["set", { strings: { set: ["only"] } }],
    ["set empty", { strings: { set: [] } }],
    ["bare array", { strings: ["bare"] }],
    ["push one", { strings: { push: "appended" } }],
    ["push many", { strings: { push: ["one", "two"] } }],
    ["push onto an empty list", { floats: { push: 1.25 } }],
    ["push a bigint", { bigints: { push: 9007199254740994n } }],
    ["push an enum label", { labels: { push: "blocked" } }],
    ["push a json value", { documents: { push: { c: 3 } } }],
    ["push bytes", { blobs: { push: new Uint8Array([7]) } }],
    ["set a mapped column", { renamed: { set: ["remapped"] } }],
  ];

  test.each(WRITES)("update: %s", async (_name, data) => {
    await differential.expectSameWrite(
      "Tagged",
      "update",
      { where: { id: 1 }, data },
      { tables: ["Tagged"] },
    );
  });

  test("updateMany pushes onto every matched row", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "updateMany",
      { where: { strings: { has: "alpha" } }, data: { ints: { push: 99 } } },
      { tables: ["Tagged"] },
    );
  });

  test("upsert creates and then updates the same list", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "upsert",
      {
        where: { id: 20 },
        create: { id: 20, strings: ["created"] },
        update: { strings: { push: "updated" } },
      },
      { tables: ["Tagged"] },
    );
    await differential.expectSameWrite(
      "Tagged",
      "upsert",
      {
        where: { id: 1 },
        create: { id: 1, strings: ["created"] },
        update: { strings: { push: "updated" } },
      },
      { tables: ["Tagged"] },
    );
  });

  test("deleteMany by a list filter", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "deleteMany",
      { where: { strings: { isEmpty: true } } },
      { tables: ["Tagged", "Note"] },
    );
  });

  // --- refusals ------------------------------------------------------------

  /**
   * The operator sets are disjoint, and gemi says so rather than compiling
   * something. Prisma refuses these too — its generated types have no
   * `contains` on a `StringNullableListFilter` — so this is parity, not
   * strictness.
   */
  test("a scalar operator on a list is refused, naming both sets", async () => {
    await expect(
      models.Tagged.findMany({ where: { strings: { contains: "a" } } }),
    ).rejects.toThrow(/scalar list.*list filter takes/s);
  });

  /**
   * Prisma refuses this — *"Expected StringNullableListFilter, provided
   * (String)"* — so gemi does too. It accepted it at first, which is a silent
   * *superset* of Prisma: the query ran, returned plausible rows, and only the
   * comparison against Prisma's refusal caught it.
   */
  test("a bare array is not a filter, and the error says what is", async () => {
    await expect(
      models.Tagged.findMany({ where: { strings: ["alpha"] } }),
    ).rejects.toThrow(/bare array is not a filter/);
  });

  test("a bare array IS a value in data", async () => {
    await differential.expectSameWrite(
      "Tagged",
      "update",
      { where: { id: 1 }, data: { strings: ["bare", "value"] } },
      { tables: ["Tagged"] },
    );
  });

  test("a list operator on a scalar is refused", async () => {
    await expect(
      models.Tagged.findMany({ where: { id: { has: 1 } } }),
    ).rejects.toThrow(/has/);
  });

  test("hasEvery with a non-array is refused with the value's type", async () => {
    await expect(
      models.Tagged.findMany({ where: { strings: { hasEvery: "alpha" } } }),
    ).rejects.toThrow(/Expected an array, received string/);
  });

  test("increment on a list is refused", async () => {
    await expect(
      models.Tagged.update({ where: { id: 1 }, data: { ints: { increment: 1 } } }),
    ).rejects.toThrow();
  });
});
