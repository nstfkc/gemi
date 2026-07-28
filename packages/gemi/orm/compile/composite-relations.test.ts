import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import { ledger, ledgerEntry } from "../fixtures";
import * as registry from "../registry";
import { lateralStrategy } from "./lateral";
import { compileRead } from "./read";
import { compileWrite } from "./write";

/**
 * Multi-field relations — `@relation(fields: [a, b], references: [c, d])`.
 *
 * Not implemented (#67), and the point of this file is the *shape* of the
 * refusal rather than the feature:
 *
 * 1. **Every surface refuses.** A one-field assumption reached by any path
 *    would join on the first field and silently return the wrong rows — the
 *    worst failure available here, because the query succeeds. Seven surfaces
 *    correlate over a relation, and each has its own compiler; they are safe
 *    only because all seven resolve their link through one function. That is a
 *    property to hold, not a coincidence to rediscover.
 *
 * 2. **Each names the operation it came from.** They all used to report
 *    `(Model.include)` — a composite relation named in a `where`, in an
 *    `orderBy`, or in a nested `connect` on a `create` sent the reader to an
 *    `include` they had not written.
 *
 * When the feature lands this file inverts: the refusals become assertions
 * about emitted SQL, and the list of surfaces is already here.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

beforeEach(() => {
  registry.clearRegistry();
  registry.register("Ledger", class { static $schema = ledger });
  registry.register("LedgerEntry", class { static $schema = ledgerEntry });
});

afterEach(() => registry.clearRegistry());

/** `[surface, run, model, operation]` — the seven paths that correlate. */
const SURFACES: [string, () => unknown, string, string][] = [
  [
    "include, to-many",
    () => compileRead(ledger, "findMany", { include: { entries: true } }, sqlite),
    "Ledger",
    "findMany",
  ],
  [
    "include, to-one",
    () => compileRead(ledgerEntry, "findMany", { include: { ledger: true } }, sqlite),
    "LedgerEntry",
    "findMany",
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
    "Ledger",
    "findMany",
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
    "Ledger",
    "findMany",
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
    "Ledger",
    "findMany",
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
    "LedgerEntry",
    "findMany",
  ],
  [
    "a nested write",
    () =>
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
      ),
    "Ledger",
    "create",
  ],
];

describe("a multi-field relation is refused, everywhere", () => {
  test.each(SURFACES)("%s", (_label, run) => {
    expect(run).toThrow(UnsupportedQueryError);
    expect(run).toThrow(/joins on 2 fields/);
  });

  /**
   * The half that was wrong: a refusal has to name where it came from, or it
   * sends the reader to a query they did not write. `#61`'s rule.
   */
  test.each(SURFACES)("%s names its own operation", (_label, run, model, operation) => {
    expect(run).toThrow(`(${model}.${operation})`);
  });

  /** And says what to do instead, rather than only what it will not do. */
  test("the message offers a way through", () => {
    const run = () =>
      compileRead(ledger, "findMany", { include: { entries: true } }, sqlite);

    expect(run).toThrow(/composite key comparison/);
    expect(run).toThrow(/DB\.query/);
  });

  /**
   * Both sides, because the two are resolved differently: the owning side reads
   * `from` / `to` off its own relation, and the other side has to find its
   * counterpart through `relationName` first.
   */
  test("it is refused from the referenced side as well as the owning one", () => {
    expect(() =>
      compileRead(ledger, "findMany", { include: { entries: true } }, sqlite),
    ).toThrow(/to: tenantId, code/);

    expect(() =>
      compileRead(ledgerEntry, "findMany", { include: { ledger: true } }, sqlite),
    ).toThrow(/from: tenantId, ledgerCode/);
  });

  /**
   * A single-field relation on the same models still compiles — otherwise this
   * suite would pass for a compiler that refused every relation.
   */
  test("a single-field relation is unaffected", () => {
    registry.register("Ledger", class { static $schema = ledger });
    const single = {
      ...ledgerEntry,
      relations: {
        ledger: { ...ledgerEntry.relations.ledger, from: ["ledgerCode"], to: ["code"] },
      },
    };
    registry.register("LedgerEntry", class { static $schema = single });

    expect(() =>
      compileRead(single, "findMany", { include: { ledger: true } }, sqlite),
    ).not.toThrow();
  });
});
