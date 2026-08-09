import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { RecordNotFoundError, UnknownFieldError } from "../errors";
import {
  ledger,
  ledgerEntry,
  ledgerNote,
  ledgerSeal,
  ledgerWithOptional,
} from "../fixtures";
import * as registry from "../registry";
import { createBindContext } from "./fragment";
import { lateralStrategy } from "./lateral";
import { compileRead } from "./read";
import { compileWrite } from "./write";
import { plannerCompositeIn } from "./where";

/**
 * Multi-field relations — `@relation(fields: [a, b], references: [c, d])`.
 *
 * **This file has inverted twice, exactly as it said it would.** It used to
 * assert that seven surfaces refuse a composite relation, on the reasoning that
 * a one-field assumption reached by any path would join on the first field and
 * silently return the wrong rows. #67 implemented six of the seven, so those six
 * assert the SQL instead — *every* joined field appears in the correlation,
 * which is the same property from the other side.
 *
 * The seventh was a nested write, refused on the argument that reading across a
 * composite relation is a wider correlation where writing through one has to
 * contribute that many foreign-key columns to an insert. #271 does that, and the
 * last section of this file asserts it the same way: not with SQL, which a write
 * has none of for a link, but by running the planned steps and reading the
 * arguments they hand the child's own operations.
 *
 * `singleFieldLink` survives with one caller — the implicit many-to-many join
 * table, where one column a side is Prisma's own shape rather than a limit here.
 *
 * What has *not* changed is the reason the list is exhaustive: all seven resolve
 * their link through one function, so a new surface inherits composite support
 * rather than having to grow it.
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

  /**
   * ...and a planner operand naming a field the model does not have.
   *
   * The shape checks above pass it — `["nosuchfield"]` is a non-empty array of
   * strings with matching tuples — so the only thing that catches it is the
   * field lookup in `compileCompositeIn`, and that lookup was the one guard in
   * this family with no test. Found by re-running the construction-site
   * coverage from #114 against the merged composite work.
   *
   * `UnknownFieldError` rather than the "planner built" wording, and that is
   * right: the shape is fine and the *name* is wrong, which is the same thing
   * the caller-facing path reports for the same mistake.
   */
  test("a planner operand naming a field that is not there", () => {
    const planners = plannerCompositeIn(["nosuchfield"], [[1]]);

    expect(() =>
      compileRead(ledgerEntry, "findMany", { where: { $compositeIn: planners } }, postgres),
    ).toThrow(UnknownFieldError);

    // The known fields are listed, which is what makes it actionable.
    expect(() =>
      compileRead(ledgerEntry, "findMany", { where: { $compositeIn: planners } }, postgres),
    ).toThrow(/is not a field on model LedgerEntry/);
  });

  /** ...and the planner's own still compiles, on the dialect that binds it. */
  test("the planner's own is accepted", () => {
    const plan = compileRead(ledgerEntry, "findMany", { include: { ledger: true } }, postgres);
    expect(plan.relations).toHaveLength(1);
  });
});

/**
 * **The seventh surface, which used to be the refusal** (#271).
 *
 * A nested write does not correlate — it *writes* — so there is no SQL fragment
 * to assert. What it produces is a list of foreign-key contributions folded
 * into the caller's own statement, and a list of steps that read and write the
 * child through the child's own `$exec`. Both are checked here by running them:
 * the steps are driven with a recording executor, and the arguments they hand
 * it are the thing that has to name every joined field.
 *
 * The property is the same one the read surfaces assert, transposed. A `where`
 * naming one field of two matches every row in the tenant; a `data` naming one
 * field of two writes half a link, which joins to nothing and leaves the other
 * column holding whatever it held before. Both *succeed*, which is why they are
 * asserted rather than left to a smoke test.
 *
 * Four shapes are needed and the fixtures carry all four:
 *
 *     ledgerEntry.ledger    owning side, required     connect / create / update
 *     ledgerSeal.ledger     owning side, one-to-one   disconnect, displacement
 *     ledger.entries        foreign side, to-many     the list operands
 *     ledgerWithOptional.*  foreign side, optional    set, disconnect, displace
 */
describe("a nested write contributes every joined field", () => {
  /** Every `exec` a step made, in order, with the arguments it passed. */
  interface Call {
    model: string;
    op: string;
    args: any;
    ormAuthored?: readonly string[];
  }

  /**
   * A `RelationExecutor` that records instead of running.
   *
   * `returns` answers the reads a step makes — a `connect` looks the far row
   * up, a `set` reads what is linked — keyed by `<model>.<op>` and consumed in
   * order, so a step that reads twice can be given two different answers.
   */
  const recorder = (returns: Record<string, unknown[]> = {}) => {
    const calls: Call[] = [];
    const executor = {
      async exec(
        model: string,
        op: string,
        args: unknown,
        _preScoped: boolean,
        ormAuthored?: readonly string[],
      ) {
        calls.push({ model, op, args, ormAuthored });
        const queue = returns[`${model}.${op}`];
        return queue && queue.length > 0 ? queue.shift() : null;
      },
    };
    return { calls, executor: executor as never };
  };

  beforeEach(() => {
    registry.clearRegistry();
    registry.register("Ledger", class { static $schema = ledgerWithOptional });
    registry.register("LedgerEntry", class { static $schema = ledgerEntry });
    registry.register("LedgerNote", class { static $schema = ledgerNote });
    registry.register("LedgerSeal", class { static $schema = ledgerSeal });
  });

  // --- the owning side -----------------------------------------------------

  /**
   * `connect` takes the lookup on a composite relation, deliberately.
   *
   * The single-field shortcut reads the referenced value straight out of the
   * operand, and Prisma spells a multi-column unique key in its compound form —
   * `{ tenantId_code: { … } }` — so there is no key here whose value is a
   * referenced column. One statement, which is what Prisma issues for every
   * `connect` on either shape.
   */
  test("connect resolves both referenced columns through one lookup", async () => {
    const args = {
      data: {
        amount: 1,
        ledger: { connect: { tenantId_code: { tenantId: 1, code: "a" } } },
      },
    };
    const plan = compileWrite(ledgerEntry, "create", args, sqlite);

    expect(plan.before).toHaveLength(1);

    const { calls, executor } = recorder({
      "Ledger.findUniqueOrThrow": [{ tenantId: 1, code: "a" }],
    });
    const context = createBindContext();
    await plan.before![0].run(args, context, executor, []);

    // Both columns read back, or the second contribution binds `undefined`.
    expect(calls[0].args.select).toEqual({ tenantId: true, code: true });
    expect(context.resolved).toEqual({ tenantId: 1, ledgerCode: "a" });

    // ...and both are columns of the insert, under the *child's* names.
    expect(plan.text).toContain(`"tenantId"`);
    expect(plan.text).toContain(`"ledgerCode"`);
    expect(plan.bind(args, context)).toEqual(expect.arrayContaining([1, "a"]));
  });

  /** A nested `create` reads the new row's whole key back before binding it. */
  test("create resolves both referenced columns from the new row", async () => {
    const args = {
      data: {
        amount: 1,
        ledger: { create: { tenantId: 9, code: "z", title: "t" } },
      },
    };
    const plan = compileWrite(ledgerEntry, "create", args, sqlite);

    const { calls, executor } = recorder({
      "Ledger.create": [{ tenantId: 9, code: "z" }],
    });
    const context = createBindContext();
    await plan.before![0].run(args, context, executor, []);

    expect(calls[0].args.select).toEqual({ tenantId: true, code: true });
    expect(context.resolved).toEqual({ tenantId: 9, ledgerCode: "z" });
  });

  /**
   * A nested `update` through the owning side needs the *current* key, which
   * only the parent statement can supply — so both columns go into `RETURNING`,
   * and the child is then found by both.
   */
  test("update returns both key columns and filters the child on both", async () => {
    const args = {
      where: { id: 1 },
      data: { amount: 2, ledger: { update: { title: "renamed" } } },
      select: { amount: true },
    };
    const plan = compileWrite(ledgerEntry, "update", args, sqlite);

    expect(plan.text).toContain(`returning "tenantId", "ledgerCode", "amount"`);
    expect(plan.hidden).toEqual(["tenantId", "ledgerCode"]);

    const { calls, executor } = recorder();
    await plan.after![0].run(args, createBindContext(), executor, [
      { tenantId: 1, ledgerCode: "a", amount: 2 } as never,
    ]);

    expect(calls[0].op).toBe("updateMany");
    // The child's own column names, paired positionally with the parent's.
    expect(calls[0].args.where).toEqual({ tenantId: 1, code: "a" });
  });

  /**
   * **A half-written composite key names no row**, so an `update` through it is
   * the *absent* case rather than a lookup that finds nothing later.
   *
   * Unreachable through `ledgerEntry`, whose columns are required — which is
   * why it is asserted on the optional pair.
   */
  test("update through a partially-null key raises rather than filtering", async () => {
    const args = {
      where: { id: 1 },
      data: { ledger: { update: { title: "x" } } },
    };
    const plan = compileWrite(ledgerSeal, "update", args, sqlite);

    const { calls, executor } = recorder();
    await expect(
      plan.after![0].run(args, createBindContext(), executor, [
        { tenantId: 1, ledgerCode: null } as never,
      ]),
    ).rejects.toThrow(RecordNotFoundError);

    // Nothing read and nothing written on a key that joins nowhere.
    expect(calls).toEqual([]);
  });

  /** A required composite relation cannot be detached, and the message says which column. */
  test("disconnect on a required composite relation is refused by column", () => {
    expect(() =>
      compileWrite(
        ledgerEntry,
        "update",
        { where: { id: 1 }, data: { ledger: { disconnect: true } } },
        sqlite,
      ),
    ).toThrow(/'LedgerEntry.tenantId' is required/);
  });

  /** `disconnect: true` clears the whole key, in the caller's own statement. */
  test("disconnect true binds every column to null", () => {
    const args = { where: { id: 1 }, data: { ledger: { disconnect: true } } };
    const plan = compileWrite(ledgerSeal, "update", args, sqlite);

    expect(plan.before).toBeUndefined();
    expect(plan.text).toContain(`"tenantId" = ?`);
    expect(plan.text).toContain(`"ledgerCode" = ?`);
    expect(plan.bind(args, createBindContext())).toEqual([null, null, 1]);
  });

  /**
   * The filter arm reads the linked row through *both* columns, and detaches
   * both or neither.
   */
  test("disconnect by filter correlates on both columns", async () => {
    const args = {
      where: { id: 1 },
      data: { ledger: { disconnect: { title: "one-a" } } },
    };
    const plan = compileWrite(ledgerSeal, "update", args, sqlite);

    const { calls, executor } = recorder({
      "LedgerSeal.findFirst": [{ tenantId: 1, ledgerCode: "a" }],
      "Ledger.findFirst": [{ tenantId: 1, code: "a" }],
    });
    const context = createBindContext();
    await plan.before![0].run(args, context, executor, []);

    expect(calls[0].args.select).toEqual({ tenantId: true, ledgerCode: true });
    expect(calls[1].args.where).toEqual({
      AND: [{ title: "one-a" }, { tenantId: 1, code: "a" }],
    });
    expect(context.resolved).toEqual({ tenantId: null, ledgerCode: null });
  });

  /**
   * **The composite one-to-one displaces**, which is the branch whose
   * discriminator stops being a single-column index.
   *
   * `LedgerSeal` carries `@@unique([tenantId, ledgerCode])` — covering exactly
   * the relation's fields — beside a non-list back-relation, and that is a
   * schema `prisma validate` accepts on 6.19.2. The clear has to name both
   * columns: nulling one leaves the sibling holding half a key that still
   * occupies the index.
   */
  test("a one-to-one connect clears the incumbent's whole key", async () => {
    const args = {
      where: { id: 1 },
      data: {
        ledger: { connect: { tenantId_code: { tenantId: 1, code: "a" } } },
      },
    };
    const plan = compileWrite(ledgerSeal, "update", args, sqlite);

    const { calls, executor } = recorder({
      "Ledger.findUniqueOrThrow": [{ tenantId: 1, code: "a" }],
      // The row being written holds a *different* ledger, so the skip does not
      // apply and the incumbent is cleared.
      "LedgerSeal.findFirst": [{ tenantId: 1, ledgerCode: "b" }],
      "LedgerSeal.findMany": [[{ tenantId: 1, ledgerCode: "a" }]],
    });
    await plan.before![0].run(args, createBindContext(), executor, []);

    const cleared = calls.find((call) => call.op === "updateMany")!;
    expect(cleared.args.where).toEqual({ tenantId: 1, ledgerCode: "a" });
    expect(cleared.args.data).toEqual({ tenantId: null, ledgerCode: null });
    expect(cleared.ormAuthored).toEqual(["tenantId", "ledgerCode"]);
  });

  /**
   * ...and the skip that suppresses it compares the *whole* tuple.
   *
   * "Some column matches" would skip the clear for a sibling holding
   * `(1, "b")` while this row takes `(1, "a")`, and the repoint would then
   * collide on an index the caller cannot see.
   */
  test("the displacement skip compares every column", async () => {
    const args = {
      where: { id: 1 },
      data: {
        ledger: { connect: { tenantId_code: { tenantId: 1, code: "a" } } },
      },
    };
    const plan = compileWrite(ledgerSeal, "update", args, sqlite);

    const { calls, executor } = recorder({
      "Ledger.findUniqueOrThrow": [{ tenantId: 1, code: "a" }],
      // Same tenant, different code: one column agrees and the row is not
      // already linked, so the clear must still be attempted.
      "LedgerSeal.findFirst": [{ tenantId: 1, ledgerCode: "b" }],
      "LedgerSeal.findMany": [[]],
    });
    await plan.before![0].run(args, createBindContext(), executor, []);

    expect(calls.some((call) => call.op === "findMany")).toBe(true);
  });

  // --- the foreign side ----------------------------------------------------

  /** Every parent key column goes into `RETURNING`, or the stamp is half a key. */
  test("a foreign-side step returns every parent key column", () => {
    const plan = compileWrite(
      ledgerWithOptional,
      "create",
      {
        data: {
          tenantId: 1,
          code: "a",
          title: "t",
          entries: { create: [{ amount: 1 }] },
        },
        select: { title: true },
      },
      sqlite,
    );

    expect(plan.after).toHaveLength(1);
    expect(plan.text).toContain(`returning "tenantId", "code", "title"`);
    expect(plan.hidden).toEqual(["tenantId", "code"]);
  });

  /**
   * `[label, operand, what to read off the child's call, what it has to be]`.
   *
   * One parent row, `(tenantId: 1, code: "a")`, and the child's link columns
   * are `(tenantId, ledgerCode)` — so a correct stamp is
   * `{ tenantId: 1, ledgerCode: "a" }`. The failure modes are either half of
   * it, or `{ tenantId: 1, ledgerCode: 1 }` from a positional pairing that
   * slipped, and every one of them writes rows rather than raising.
   */
  const FOREIGN: [string, unknown, (call: Call) => unknown, unknown][] = [
    [
      "create stamps the whole key onto the new row",
      { create: [{ amount: 1 }] },
      (call) => call.args.data,
      { amount: 1, tenantId: 1, ledgerCode: "a" },
    ],
    [
      "createMany stamps it onto every row",
      { createMany: { data: [{ amount: 1 }, { amount: 2 }] } },
      (call) => call.args.data,
      [
        { amount: 1, tenantId: 1, ledgerCode: "a" },
        { amount: 2, tenantId: 1, ledgerCode: "a" },
      ],
    ],
    [
      "connect repoints the child on both columns",
      { connect: [{ id: 7 }] },
      (call) => call.args.data,
      { tenantId: 1, ledgerCode: "a" },
    ],
    [
      "updateMany conjoins the whole key rather than spreading it",
      { updateMany: { where: { amount: 1 }, data: { memo: "m" } } },
      (call) => call.args.where,
      { AND: [{ amount: 1 }, { tenantId: 1, ledgerCode: "a" }] },
    ],
    [
      "deleteMany conjoins it too",
      { deleteMany: { amount: 1 } },
      (call) => call.args.where,
      { AND: [{ amount: 1 }, { tenantId: 1, ledgerCode: "a" }] },
    ],
  ];

  test.each(FOREIGN)("%s", async (_label, operand, read, expected) => {
    const args = {
      where: { tenantId_code: { tenantId: 1, code: "a" } },
      data: { title: "t", entries: operand },
    };
    const plan = compileWrite(ledgerWithOptional, "update", args, sqlite);

    const { calls, executor } = recorder();
    await plan.after![0].run(args, createBindContext(), executor, [
      { tenantId: 1, code: "a" } as never,
    ]);

    expect(read(calls[calls.length - 1])).toEqual(expected);
  });

  /** `connect` names both columns as the ORM's own, for the scope-escape guard. */
  test("connect declares every stamped column as ORM-authored", async () => {
    const args = {
      where: { tenantId_code: { tenantId: 1, code: "a" } },
      data: { title: "t", entries: { connect: [{ id: 7 }] } },
    };
    const plan = compileWrite(ledgerWithOptional, "update", args, sqlite);

    const { calls, executor } = recorder();
    await plan.after![0].run(args, createBindContext(), executor, [
      { tenantId: 1, code: "a" } as never,
    ]);

    expect(calls[0].ormAuthored).toEqual(["tenantId", "ledgerCode"]);
  });

  /** `set` is refused where the child's columns are required, by column name. */
  test("set on a required composite child is refused", () => {
    expect(() =>
      compileWrite(
        ledgerWithOptional,
        "update",
        {
          where: { tenantId_code: { tenantId: 1, code: "a" } },
          data: { entries: { set: [{ id: 1 }] } },
        },
        sqlite,
      ),
    ).toThrow(/'LedgerEntry.tenantId' is required/);
  });

  /** ...and clears and re-links both columns where they are not. */
  test("set clears every column and re-links every column", async () => {
    const args = {
      where: { tenantId_code: { tenantId: 1, code: "a" } },
      data: { notes: { set: [{ id: 3 }] } },
    };
    const plan = compileWrite(ledgerWithOptional, "update", args, sqlite);

    const { calls, executor } = recorder({
      "LedgerNote.findMany": [[{ tenantId: 1, ledgerCode: "a" }]],
    });
    await plan.after![0].run(args, createBindContext(), executor, [
      { tenantId: 1, code: "a" } as never,
    ]);

    const [read, clear, link] = calls;
    expect(read.args.where).toEqual({ tenantId: 1, ledgerCode: "a" });
    expect(clear.args.data).toEqual({ tenantId: null, ledgerCode: null });
    expect(clear.ormAuthored).toEqual(["tenantId", "ledgerCode"]);
    expect(link.args.data).toEqual({ tenantId: 1, ledgerCode: "a" });
  });

  /** `disconnect` nulls the whole key on the rows it names. */
  test("disconnect nulls every column of the link", async () => {
    const args = {
      where: { tenantId_code: { tenantId: 1, code: "a" } },
      data: { notes: { disconnect: [{ id: 3 }] } },
    };
    const plan = compileWrite(ledgerWithOptional, "update", args, sqlite);

    const { calls, executor } = recorder();
    await plan.after![0].run(args, createBindContext(), executor, [
      { tenantId: 1, code: "a" } as never,
    ]);

    expect(calls[0].args.where).toEqual({
      AND: [{ id: 3 }, { tenantId: 1, ledgerCode: "a" }],
    });
    expect(calls[0].args.data).toEqual({ tenantId: null, ledgerCode: null });
    expect(calls[0].ormAuthored).toEqual(["tenantId", "ledgerCode"]);
  });

  /**
   * The foreign side of a composite one-to-one displaces on `create`, and the
   * clear names both columns — the mirror of the owning-side case above.
   */
  test("a foreign-side one-to-one create clears the incumbent's whole key", async () => {
    const args = {
      where: { tenantId_code: { tenantId: 1, code: "a" } },
      data: { seal: { create: { seal: "s" } } },
    };
    const plan = compileWrite(ledgerWithOptional, "update", args, sqlite);

    const { calls, executor } = recorder({
      "LedgerSeal.findMany": [[{ tenantId: 1, ledgerCode: "a" }]],
    });
    await plan.after![0].run(args, createBindContext(), executor, [
      { tenantId: 1, code: "a" } as never,
    ]);

    const cleared = calls.find((call) => call.op === "updateMany")!;
    expect(cleared.args.data).toEqual({ tenantId: null, ledgerCode: null });
    expect(calls[calls.length - 1].args.data).toEqual({
      seal: "s",
      tenantId: 1,
      ledgerCode: "a",
    });
  });
});

