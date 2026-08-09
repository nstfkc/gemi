import { beforeEach, describe, expect, test } from "vitest";

import { lateralStrategy } from "./compile/lateral";
import { compileRead } from "./compile/read";
import { compileWrite } from "./compile/write";
import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { ledger, ledgerEntry } from "./fixtures";
import * as registry from "./registry";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

/**
 * Which surfaces a **multi-field relation** reaches, stated as a table.
 *
 * `docs/orm.md`'s *Not in scope* list said a composite relation "is refused
 * wherever a relation is correlated — `include` under either strategy, a
 * relation filter, `_count`, an `orderBy` through a relation, and nested
 * writes". Four of those five stopped being true when #95 and #100 landed, and
 * the entry did not move with them. The fifth stopped being true at #271, and
 * the entry is gone: there is nothing left on that list for a reader to plan
 * around.
 *
 * That is the direction #145 was about: a *Not in scope* list is written so a
 * reader can plan around it, and one that names something already implemented
 * sends them to write raw SQL for a query that works. It drifted here because
 * the boundary moved rather than because the text was wrong when written —
 * which is exactly the case a test catches and review does not.
 *
 * `ledgerEntry.ledger` joins on `tenantId` **and** `ledgerCode`, so every case
 * below asserts *both* columns appear. One would be enough for the query to
 * compile and would silently return the wrong rows, which is the failure the
 * refusal existed to prevent.
 */
describe("a relation that joins on two fields", () => {
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("Ledger", class { static $schema = ledger });
    registry.register("LedgerEntry", class { static $schema = ledgerEntry });
  });

  /** Both sides of the composite key, as the compiler spells them. */
  const correlatesOnBoth = (sql: string) => {
    expect(sql).toMatch(/"tenantId"/);
    expect(sql).toMatch(/"ledgerCode"/);
  };

  test("include, batched", () => {
    const plan = compileRead(
      ledger,
      "findMany",
      { include: { entries: true } } as never,
      sqlite,
    );

    // Under batching the child is a second statement, so what the parent's plan
    // carries is the key it will correlate on. Asserted on the plan rather than
    // on SQL text: `parentFields` is the thing that would silently shrink to one
    // field, and it names the parent's side (`code`), not the child's column.
    const [entries] = plan.relations ?? [];
    expect(entries).toBeDefined();
    expect(entries.parentFields).toEqual(["tenantId", "code"]);
  });

  test("include, lateral", () => {
    const plan = compileRead(
      ledger,
      "findMany",
      { include: { entries: true } } as never,
      postgres,
      lateralStrategy,
    );
    expect(plan.text).toMatch(/lateral/i);
    correlatesOnBoth(plan.text);
  });

  test("a relation filter", () => {
    const { text } = compileRead(
      ledgerEntry,
      "findMany",
      { where: { ledger: { is: {} } } } as never,
      sqlite,
    );
    expect(text).toContain("exists");
    correlatesOnBoth(text);
  });

  test("_count", () => {
    const { text } = compileRead(
      ledger,
      "findMany",
      { include: { _count: { select: { entries: true } } } } as never,
      sqlite,
    );
    expect(text).toContain("count(*)");
    correlatesOnBoth(text);
  });

  test("orderBy through the relation", () => {
    const { text } = compileRead(
      ledger,
      "findMany",
      { orderBy: { entries: { _count: "asc" } } } as never,
      sqlite,
    );
    expect(text).toContain("order by");
    correlatesOnBoth(text);
  });

  /**
   * The sixth, which used to be the one refused (#271).
   *
   * This test previously asserted the refusal and said *"when this starts
   * compiling, this test fails — which is the prompt to move the entry again"*.
   * It started compiling; the entry moved; this asserts the property the
   * refusal was standing in for.
   *
   * **The parent's `RETURNING` is what makes it the same property.** A nested
   * write on this side repoints the child by the parent's key, so the columns
   * the statement returns are the columns the repoint can correlate on — return
   * one of two and the `update` below writes `tenantId` and leaves `ledgerCode`
   * holding whatever it held, which is the *first-field join* the refusal
   * existed to prevent, one layer down.
   */
  test("a nested write returns every key field to correlate on", () => {
    const plan = compileWrite(
      ledger,
      "update",
      {
        where: { tenantId_code: { tenantId: 1, code: "x" } },
        data: { title: "t", entries: { connect: { id: 1 } } },
        // Narrow, so the key columns below are in the statement *only* because
        // the nested step asked for them. Without this they would be there
        // anyway — they are the primary key — and the assertion would hold
        // whether or not the planner had asked.
        select: { title: true },
      } as never,
      sqlite,
    );

    expect(plan.after).toHaveLength(1);
    expect(plan.after?.[0].operation).toBe("connect");
    expect(plan.text).toContain(`returning "tenantId", "code", "title"`);
    // Both fetched to stitch with, neither asked for — so both are stripped
    // from the row the caller sees. One here would mean the repoint writes half
    // a key: `tenantId` set and `ledgerCode` left holding whatever it held,
    // which is the first-field join this file's refusal existed to prevent.
    expect(plan.hidden).toEqual(["tenantId", "code"]);
  });
});
