import { beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { ledger, ledgerEntry } from "../fixtures";
import * as registry from "../registry";
import { COMPOSITE_IN } from "./where";
import { compileRead } from "./read";

/**
 * **The planner chooses the composite `in` on Postgres**, which is the half of
 * #97 that nothing asserted.
 *
 * `plan.discrimination.test.ts` covers the consequence: a `where` carrying a
 * `$compositeIn` marker produces one plan key however many tuples it holds,
 * against SQLite's one per length. That test builds the marker **by hand** and
 * hands it to `planKey`, so it says what happens once the marker exists and
 * nothing about whether the planner ever creates one.
 *
 * Mutation found the difference. Inverting the guard that decides
 *
 *     types.every((type) => type !== undefined) &&
 *     dialect.canBindCompositeIn(types)
 *
 * sends every composite include down the portable `OR` instead, on both
 * dialects — and survives the unit suite *and* the template suite, because the
 * `OR` returns exactly the same rows. Only the plan count changes, and the test
 * that counts plans never asks the planner for one.
 *
 * That is the shape worth guarding: a regression here is invisible to every
 * correctness test by construction. It costs one plan cache entry and one
 * prepared statement per distinct parent count, on the query the relation
 * loader issues for *every* batched include.
 *
 * Asserted on the arguments the loader passes to the child model's `$exec`,
 * which is where the marker travels — no database, and no dependence on the
 * emitted SQL text.
 */
const postgres = new PostgresDialect();
const sqlite = new SqliteDialect();

/** The `where` the loader hands the child model, for a composite relation. */
async function childWhere(dialect: PostgresDialect | SqliteDialect) {
  const plan = compileRead(
    ledger,
    "findMany" as never,
    { include: { entries: true } } as never,
    dialect as never,
  );

  const [entries] = (plan as { relations?: { load: unknown }[] }).relations ?? [];
  expect(entries, "the include produced no relation node").toBeDefined();

  let captured: Record<string, unknown> | undefined;
  const executor = {
    exec(_model: string, _op: string, args: unknown) {
      captured = (args as { where?: Record<string, unknown> }).where;
      return Promise.resolve([]);
    },
  };

  // `load(parents, args, executor)` — the args are the caller's original tree,
  // which for a bare `include: { entries: true }` is just that.
  await (entries as unknown as {
    load: (rows: unknown[], args: unknown, executor: unknown) => Promise<unknown>;
  }).load(
    [
      { tenantId: 1, code: "a" },
      { tenantId: 2, code: "b" },
    ],
    { include: { entries: true } },
    executor,
  );

  return captured;
}

describe("the planner picks the composite `in` where the dialect has one", () => {
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("Ledger", class { static $schema = ledger });
    registry.register("LedgerEntry", class { static $schema = ledgerEntry });
  });

  test("postgres gets the marker, so the text is fixed however many parents arrive", async () => {
    const where = await childWhere(postgres);

    expect(where, "the loader issued no child query").toBeDefined();
    expect(Object.keys(where!)).toContain(COMPOSITE_IN);
  });

  /**
   * SQLite has no `unnest`, so `canBindCompositeIn` says no and the portable
   * `OR` stands. Asserted rather than assumed: the guard has two halves and a
   * test for only the positive one would pass if the dialect check were dropped
   * entirely.
   */
  test("sqlite keeps the portable OR", async () => {
    const where = await childWhere(sqlite);

    expect(where).toBeDefined();
    expect(Object.keys(where!)).not.toContain(COMPOSITE_IN);
  });
});
