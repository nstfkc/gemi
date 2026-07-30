import { beforeEach, describe, expect, test } from "vitest";

import { lateralStrategy } from "./compile/lateral";
import { compileRead } from "./compile/read";
import { compileWrite } from "./compile/write";
import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { UnsupportedQueryError } from "./errors";
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
 * the entry did not move with them.
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
   * The one still refused, and the reason the docs entry is narrowed rather
   * than deleted. When this starts compiling, this test fails — which is the
   * prompt to move the entry again.
   */
  test("a nested write is still refused, by name", () => {
    let error: UnsupportedQueryError | null = null;
    try {
      compileWrite(
        ledger,
        "update",
        {
          where: { tenantId_code: { tenantId: 1, code: "x" } },
          data: { entries: { connect: { id: 1 } } },
        } as never,
        sqlite,
      );
    } catch (raised) {
      error = raised as UnsupportedQueryError;
    }

    expect(error).toBeInstanceOf(UnsupportedQueryError);
    // The message names the count and the fields, which is what makes it
    // actionable rather than a shrug.
    expect(error!.message).toMatch(/joins on 2 fields/);
    expect(error!.message).toContain("tenantId");
  });
});
