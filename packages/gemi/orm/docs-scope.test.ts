import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { isAggregateOperation } from "./compile/aggregate";
import { isGroupByOperation } from "./compile/group-by";
import { isReadOperation } from "./compile/read";
import { isWriteOperation } from "./compile/write";
import * as orm from "./index";
import type { Operation } from "./plan";

/**
 * `docs/orm.md`'s **Not in scope** list, checked against the runtime.
 *
 * `read.test.ts` already guards one direction: `cursor` and `distinct` raise
 * `UnsupportedByDesignError` rather than "yet", and its comment names why —
 * "which is how `docs/orm.md` came to list an argument under *Not in scope*
 * while the runtime said 'yet'."
 *
 * Nothing guarded the **other** direction, and the doc had drifted that way
 * instead: it listed *"No `groupBy` or `aggregate`. These land in Raw SQL"*
 * while the same document documents both with worked examples, the compiler
 * implements both, and the differential harness compares both against Prisma.
 *
 * That is worse than the failure #68 fixed. "Refused, but actually works" tells
 * a reader to go and write raw SQL for a query the ORM would have answered, and
 * unlike a runtime refusal there is nothing to bump into that corrects them.
 *
 * The section is prose, so this does not try to parse the reasons — only to
 * assert that it never names an operation the ORM implements.
 */
const DOC = join(import.meta.dirname, "../../../docs/orm.md");

/**
 * The operations the ORM implements. Listed here because `Operation` is a type
 * and erased — but every entry is then **verified** against the compiler's own
 * predicates, so this cannot quietly name something that does not exist.
 */
const IMPLEMENTED: Operation[] = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
];

describe("docs/orm.md and the runtime agree", () => {
  const source = readFileSync(DOC, "utf8");

  const notInScope = (() => {
    const start = source.indexOf("\n## Not in scope");
    expect(start, "the Not in scope section moved or was renamed").toBeGreaterThan(0);
    const end = source.indexOf("\n## ", start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  })();

  test("the list is found, and is not empty", () => {
    expect(notInScope.length).toBeGreaterThan(200);
  });

  /** The list itself has to be real operations, or the check below means little. */
  test.each(IMPLEMENTED)("%s is an operation the compiler recognises", (operation) => {
    expect(
      isReadOperation(operation) ||
        isWriteOperation(operation) ||
        isAggregateOperation(operation) ||
        isGroupByOperation(operation),
    ).toBe(true);
  });

  /**
   * The assertion. An implemented operation named in this section is a
   * contradiction a reader has no way to resolve — and the reader who believes
   * it writes raw SQL for a query that already works.
   *
   * Matched on the backticked spelling, which is how the section names an API
   * surface. Prose like "no lazy loading" is deliberately not matched: it names
   * a feature rather than an operation, and there is nothing to check it
   * against.
   */
  test.each(IMPLEMENTED)("%s is not listed as out of scope", (operation) => {
    expect(notInScope).not.toContain(`\`${operation}\``);
  });

  /**
   * ...and the two that genuinely are refused by design stay named, so removing
   * them from the doc while leaving the runtime refusing is caught too. That is
   * the direction #68 fixed, kept honest from this side as well.
   */
  test.each(["distinct", "cursor"])("%s is still listed, because it is still refused", (argument) => {
    expect(notInScope).toContain(`\`${argument}\``);
  });
});

/**
 * The **Errors** table, checked for completeness.
 *
 * The section opens "Every failure is a typed error from `gemi/orm`" and then
 * gives a table, which a reader takes as the catalogue — it is where you look
 * to find out what there is to catch.
 *
 * It listed 12 of the ORM's 20. The costly omission was `UnsupportedByDesignError`:
 * the **Not in scope** section tells you the deliberate refusals throw it and
 * that telling *decision* from *not yet* is the whole point of the split (#68),
 * and then the place you would look for the class did not mention it.
 *
 * Derived from the module's own exports rather than a hand-written list. The
 * list in this file for operations had to be verified against the compiler's
 * predicates for the same reason; here the exports *are* the source, so there is
 * nothing to keep in step.
 */
describe("docs/orm.md lists every error an application can catch", () => {
  const source = readFileSync(DOC, "utf8");

  const errorsTable = (() => {
    const start = source.indexOf("\n## Errors");
    expect(start, "the Errors section moved or was renamed").toBeGreaterThan(0);
    const end = source.indexOf("\n## ", start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  })();

  /**
   * Every export that is an `Error` subclass. `instanceof` on the prototype
   * rather than a name test, so a class that stopped extending `Error` — and
   * therefore stopped being catchable the documented way — drops out here
   * rather than being counted.
   */
  const exported = Object.entries(orm)
    .filter(
      ([, value]) =>
        typeof value === "function" &&
        value.prototype instanceof Error,
    )
    .map(([name]) => name)
    .sort();

  test("the exports are found", () => {
    expect(exported.length).toBeGreaterThan(15);
    expect(exported).toContain("UnsupportedQueryError");
  });

  test.each(exported)("%s is in the table", (name) => {
    expect(errorsTable).toContain(`\`${name}\``);
  });
});
