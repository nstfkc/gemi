import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import { ledger, ledgerEntry } from "../fixtures";
import * as registry from "../registry";
import { lateralStrategy } from "./lateral";
import { compileRead } from "./read";
import { compileWrite } from "./write";
import { plannerCompositeIn } from "./where";

/**
 * Multi-field relations — `@relation(fields: [a, b], references: [c, d])`.
 *
 * **This file has inverted, exactly as it said it would.** It used to assert
 * that seven surfaces refuse a composite relation, on the reasoning that a
 * one-field assumption reached by any path would join on the first field and
 * silently return the wrong rows. #67 implements six of the seven, so those six
 * now assert the SQL — *every* joined field appears in the correlation, which is
 * the same property from the other side.
 *
 * The seventh is a nested write, and it still refuses: reading across a
 * composite relation is a wider correlation, writing through one would have to
 * contribute that many foreign-key columns to an insert. The refusal is now a
 * `singleFieldLink` call rather than a shared resolver, so the narrowing is a
 * function nobody can reach past — there is no single-field property on `Link`
 * to index into.
 *
 * What has *not* changed is the reason the list is exhaustive: all seven still
 * resolve their link through one function, so a new surface inherits composite
 * support rather than having to grow it.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

beforeEach(() => {
  registry.clearRegistry();
  registry.register("Ledger", class { static $schema = ledger });
  registry.register("LedgerEntry", class { static $schema = ledgerEntry });
});

afterEach(() => registry.clearRegistry());

/**
 * `[surface, run, fragments]` — the read paths that correlate, and the SQL each
 * has to contain. Every one names *both* joined fields.
 */
const READ_SURFACES: [string, () => unknown, string[]][] = [
  [
    "include, to-many (batched)",
    () => compileRead(ledger, "findMany", { include: { entries: true } }, sqlite),
    // The batched strategy adds nothing to the root statement; it selects both
    // key fields so the second query can be filtered and stitched.
    [`"tenantId"`, `"code"`],
  ],
  [
    "include, to-one (batched)",
    () => compileRead(ledgerEntry, "findMany", { include: { ledger: true } }, sqlite),
    [`"tenantId"`, `"ledgerCode"`],
  ],
  [
    "include under the lateral strategy",
    () =>
      compileRead(
        ledger,
        "findMany",
        { include: { entries: true } },
        postgres,
        lateralStrategy,
      ),
    [
      `"tenantId" = "Ledger"."tenantId"`,
      `"ledgerCode" = "Ledger"."code"`,
    ],
  ],
  [
    "a relation filter",
    () =>
      compileRead(
        ledger,
        "findMany",
        { where: { entries: { some: { amount: 1 } } } },
        sqlite,
      ),
    [
      `"_r0"."tenantId" = "Ledger"."tenantId"`,
      `"_r0"."ledgerCode" = "Ledger"."code"`,
    ],
  ],
  [
    "_count",
    () =>
      compileRead(
        ledger,
        "findMany",
        { include: { _count: { select: { entries: true } } } },
        sqlite,
      ),
    [
      `"_c0"."tenantId" = "Ledger"."tenantId"`,
      `"_c0"."ledgerCode" = "Ledger"."code"`,
    ],
  ],
  [
    "an orderBy through a relation",
    () =>
      compileRead(
        ledgerEntry,
        "findMany",
        { orderBy: { ledger: { title: "asc" } } },
        sqlite,
      ),
    [
      `"tenantId" = "LedgerEntry"."tenantId"`,
      `"code" = "LedgerEntry"."ledgerCode"`,
    ],
  ],
];

describe("every read surface joins on all of the fields", () => {
  /**
   * `LedgerEntry` points at `Ledger` on `(tenantId, ledgerCode)`, so a
   * correlation that named only the first would match every ledger in the
   * tenant — the failure this file was written to prevent, and the one that
   * *succeeds* rather than raising.
   */
  test.each(READ_SURFACES)("%s", (_label, run, expected) => {
    const text = (run() as { text: string }).text;
    for (const fragment of expected) expect(text).toContain(fragment);
  });

  /** The pairing is positional, so both halves have to line up. */
  test("the correlation pairs the fields in order, not by name", () => {
    const { text } = compileRead(
      ledger,
      "findMany",
      { include: { _count: { select: { entries: true } } } },
      sqlite,
    );

    // `tenantId` matches `tenantId` and `code` matches `ledgerCode` — a
    // by-name pairing would fail to find the second and a positional one that
    // slipped would compare the wrong pair.
    expect(text).toContain(`"_c0"."tenantId" = "Ledger"."tenantId"`);
    expect(text).toContain(`"_c0"."ledgerCode" = "Ledger"."code"`);
  });

  /**
   * The batched strategy pages its children with an `in` over the parents'
   * keys, which a composite relation cannot express as one list. It becomes an
   * `OR` of `AND`s in *argument* space — one shape both dialects already
   * compile — rather than a tuple `in`, which only Postgres has.
   */
  test("the batched strategy filters children by an OR of ANDs", async () => {
    const plan = compileRead(ledger, "findMany", { include: { entries: true } }, sqlite);
    const relation = plan.relations![0];

    expect(relation.parentFields).toEqual(["tenantId", "code"]);

    const seen: any[] = [];
    await relation.load(
      [
        { tenantId: 1, code: "a" },
        { tenantId: 2, code: "b" },
      ] as any,
      {},
      {
        exec: async (_model: string, _op: string, args: any) => {
          seen.push(args);
          return [];
        },
      } as any,
    );

    expect(seen[0].where).toEqual({
      OR: [
        { tenantId: 1, ledgerCode: "a" },
        { tenantId: 2, ledgerCode: "b" },
      ],
    });
  });

  /**
   * The stitch key is a tuple, so two parents differing only in *where* the
   * boundary falls must not collide. Concatenation would put `("ab", "c")` and
   * `("a", "bc")` in the same bucket and attach each parent's children to the
   * other — silently, since both queries succeed.
   */
  test("the stitch key cannot collide across the field boundary", async () => {
    const plan = compileRead(ledgerEntry, "findMany", { include: { ledger: true } }, sqlite);
    const relation = plan.relations![0];

    // `ledger: null` is what the shaper writes before relations are attached;
    // a to-one only fills a slot that is already there.
    const parents: any[] = [
      { id: 1, tenantId: 1, ledgerCode: "b", ledger: null },
      { id: 2, tenantId: 1, ledgerCode: "bc", ledger: null },
      { id: 3, tenantId: 1, ledgerCode: "b", ledger: null },
    ];

    await relation.load(parents, {}, {
      exec: async () => [
        { tenantId: 1, code: "b", title: "b" },
        { tenantId: 1, code: "bc", title: "bc" },
      ],
    } as any);

    // Concatenating the fields would make `(1, "b")` and `(1, "bc")` adjacent
    // strings and, with a third parent, indistinguishable — each parent has to
    // get its own ledger.
    expect(parents[0].ledger).toMatchObject({ title: "b" });
    expect(parents[1].ledger).toMatchObject({ title: "bc" });
    expect(parents[2].ledger).toMatchObject({ title: "b" });
  });
});

/**
 * #67's third acceptance item: two composite relations differing only in field
 * *order* have to be two plans.
 *
 * The order is what pairs the sides, so `(tenantId, code)` and `(code,
 * tenantId)` are different joins that compile to different SQL — and the
 * argument shapes are identical, which is exactly the collision the plan cache
 * is built to avoid. The field names come from the schema rather than the
 * arguments, so this is really a check that the *schema* reaches the key.
 */
describe("plan discrimination", () => {
  test("field order changes the emitted correlation", () => {
    const flipped: any = {
      ...ledgerEntry,
      relations: {
        ...ledgerEntry.relations,
        ledger: {
          ...ledgerEntry.relations.ledger,
          from: ["ledgerCode", "tenantId"],
          to: ["code", "tenantId"],
        },
      },
    };

    const straight = compileRead(
      ledgerEntry,
      "findMany",
      { orderBy: { ledger: { title: "asc" } } },
      sqlite,
    ).text;
    const reversed = compileRead(
      flipped,
      "findMany",
      { orderBy: { ledger: { title: "asc" } } },
      sqlite,
    ).text;

    // Same pairs, written the other way round — and if the two sides were
    // paired by *name* rather than by position these would be identical.
    expect(straight).not.toBe(reversed);
    expect(reversed).toContain(`"code" = "LedgerEntry"."ledgerCode"`);
    expect(reversed).toContain(`"tenantId" = "LedgerEntry"."tenantId"`);
  });

  /**
   * A mismatched pair is the artifact disagreeing with the schema, not a query
   * the caller can fix — so it is a `MalformedRelationError` rather than an
   * unsupported query, and it names both sides.
   */
  test("sides of different lengths are a malformed relation", () => {
    const lopsided: any = {
      ...ledgerEntry,
      relations: {
        ...ledgerEntry.relations,
        ledger: { ...ledgerEntry.relations.ledger, to: ["code"] },
      },
    };

    expect(() =>
      compileRead(lopsided, "findMany", { include: { ledger: true } }, sqlite),
    ).toThrow(/joins 2 field\(s\) to 1/);
  });
});

/**
 * `$compositeIn` is internal, and that is enforced rather than claimed.
 *
 * The branch that compiles it sits **above** the field lookup in
 * `compileWhere`, so a caller writing the key by hand used to be honoured. Not
 * an injection — the fields are resolved against the schema, the columns go
 * through `quoteIdent`, the values are bound — but an undocumented input
 * surface with none of the operand validation its neighbours have, and one
 * shape that compiled clean and deferred its failure to bind time.
 *
 * The operand now has to carry a module-private `Symbol` the planner attaches,
 * which an application cannot reach. Same mechanism as `markPreScoped` and
 * `markOrmAuthored`, for the same reason: a claim about who may do something is
 * worth only as much as the thing that enforces it.
 */
describe("the composite-in key is the planner's alone", () => {
  const attempt = (operand: unknown) => () =>
    compileRead(ledgerEntry, "findMany", { where: { $compositeIn: operand } }, postgres);

  /**
   * The **unknown-key treatment**, which is what the original comment promised.
   * `UnsupportedQueryError` would say "does not support '$compositeIn' *yet*",
   * a promise about a key that is deliberately not in the grammar — the word
   * #82 and #88 have each already corrected once.
   */
  test("a hand-written one is not a field on the model", () => {
    const operand = { fields: ["tenantId", "ledgerCode"], values: [[1, "a"]] };
    expect(attempt(operand)).toThrow(UnknownFieldError);
    expect(attempt(operand)).toThrow(/is not a field on model LedgerEntry/);
    expect(attempt(operand)).not.toThrow(/yet/);
  });

  /**
   * The three shapes that used to escape validation: two raw `TypeError`s from
   * a destructure and a `.map`, and one that compiled with no `values` at all.
   * Every one is now an `UnsupportedQueryError` naming the key.
   */
  test.each([
    ["null", null],
    ["fields not an array", { fields: "tenantId", values: [[1]] }],
    ["no values at all", { fields: ["tenantId"] }],
    ["a tuple of the wrong width", { fields: ["tenantId", "ledgerCode"], values: [[1]] }],
  ])("a malformed one is refused rather than crashing: %s", (_label, operand) => {
    // Every one of these used to be a raw `TypeError` from a destructure or a
    // `.map`, or — for "no values at all" — a clean compile whose failure
    // arrived at bind time.
    expect(attempt(operand)).toThrow(UnknownFieldError);
    expect(attempt(operand)).not.toThrow(TypeError);
  });

  /**
   * The planner's *own* malformed operand is a different audience: an internal
   * invariant that does not hold is genuinely something the ORM does not
   * support, and there "yet" is the honest word.
   */
  test("a malformed operand from the planner names the invariant", () => {
    const planners = plannerCompositeIn(["tenantId"], [[1, "extra"]]);
    expect(() =>
      compileRead(ledgerEntry, "findMany", { where: { $compositeIn: planners } }, postgres),
    ).toThrow(/the planner built/);
  });

  /** ...and the planner's own still compiles, on the dialect that binds it. */
  test("the planner's own is accepted", () => {
    const plan = compileRead(ledgerEntry, "findMany", { include: { ledger: true } }, postgres);
    expect(plan.relations).toHaveLength(1);
  });
});

describe("a nested write still refuses, and says why", () => {
  const run = () =>
    compileWrite(
      ledger,
      "create",
      {
        data: {
          tenantId: 1,
          code: "a",
          title: "t",
          entries: { create: { amount: 1 } },
        },
      },
      sqlite,
    );

  test("it names the field count and the reason", () => {
    expect(run).toThrow(UnsupportedQueryError);
    expect(run).toThrow(/joins on 2 fields/);
    expect(run).toThrow(/Reading across a composite relation works/);
  });

  /** #61's rule: a refusal that misnames its origin sends the reader astray. */
  test("it names its own operation", () => {
    expect(run).toThrow("(Ledger.create)");
  });
});
