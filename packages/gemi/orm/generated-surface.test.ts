import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { isAggregateOperation } from "./compile/aggregate";
import { READ_ARGS } from "./compile/read";
import { WRITE_ARGS } from "./compile/write";
import { isGroupByOperation } from "./compile/group-by";
import { isReadOperation } from "./compile/read";
import { isWriteOperation } from "./compile/write";
import type { Operation } from "./plan";

/**
 * **The generated model base exposes every operation the compiler implements.**
 *
 * There are three lists of operations in this repository and, until this, only
 * two of them were reconciled:
 *
 *   the compiler        `isReadOperation` and its three siblings
 *   the documentation   the block in `docs/orm.md`, pinned to the compiler by
 *                       `docs-scope.test.ts` (#183)
 *   the generator       `READ_OPERATIONS` / `WRITE_OPERATIONS` in
 *                       `bin/orm/emit.ts`, hand-written, pinned to nothing
 *
 * The third is the one an application actually calls. An operation added to the
 * compiler and left out of the emitter would leave `docs/orm.md` correct, the
 * `docs-scope` guard green, and `User.groupBy` simply not existing — the one
 * failure mode of the three that no test could see, and the only one a reader
 * meets as "the documentation says this exists".
 *
 * That is not hypothetical for this shape of code: #182 found the operation
 * *count* wrong in three places at once, and #195 found three more, precisely
 * because each list was maintained by hand against a different copy of the
 * truth.
 *
 * Asserted against the committed artifact rather than by re-running the
 * generator, because the artifact is what the template compiles against — it is
 * committed on purpose, and `generated.test.ts` already guards that regenerating
 * it produces a zero-line diff. So this reads the file the application reads.
 */
const MODELS = join(
  import.meta.dirname,
  "../../../templates/saas-starter/app/models/generated/models.ts",
);

/**
 * The operations the compiler implements, **derived from the compiler** rather
 * than listed here.
 *
 * `docs-scope.test.ts` writes this set out by hand and verifies each entry
 * against the predicates. That catches an entry that does not exist — but not
 * an operation that exists and was never added to the list, which is the
 * direction that matters for a guard whose whole job is finding a list nobody
 * updated. A hand-written list is exactly the thing #226 is about, and writing
 * a second copy of it here would have been that bug, in the test for that bug.
 *
 * `READ_ARGS` and `WRITE_ARGS` are the tables the predicates answer from — `op
 * in READ_ARGS` is the whole of `isReadOperation` — so their keys are the
 * compiler's own record of what it implements. `aggregate` and `groupBy` are
 * named because their predicates are literal comparisons with no table behind
 * them; the count assertion below is what keeps that pair honest if a fifth
 * kind is ever added.
 */
const IMPLEMENTED = [
  ...Object.keys(READ_ARGS),
  ...Object.keys(WRITE_ARGS),
  "aggregate",
  "groupBy",
] as Operation[];

const source = readFileSync(MODELS, "utf8");

describe("the generated base exposes every implemented operation", () => {
  test("the derived set is the whole surface", () => {
    // Fifteen today. A mismatch means either a new operation — in which case
    // the assertions below now cover it, which is the point — or a fifth
    // predicate kind whose operations no table lists, which the two literals
    // above would silently miss.
    expect(IMPLEMENTED.length).toBe(15);
    expect(new Set(IMPLEMENTED).size).toBe(IMPLEMENTED.length);
  });

  test("the artifact was found", () => {
    expect(source).toContain("export class");
    expect(source.length).toBeGreaterThan(1000);
  });

  test.each(IMPLEMENTED)("%s is an operation the compiler recognises", (operation) => {
    expect(
      isReadOperation(operation) ||
        isWriteOperation(operation) ||
        isAggregateOperation(operation) ||
        isGroupByOperation(operation),
    ).toBe(true);
  });

  /**
   * Matched on the declaration rather than on the name appearing anywhere: every
   * one of these also occurs inside a `$exec("…")` call, so a looser check would
   * pass on a method that delegates without being declared — which is the half
   * that would still not exist at the call site.
   *
   * Both spellings, because the emitter uses both: most operations take a
   * generic (`static findMany<T extends …>`), while `createMany`, `updateMany`
   * and `deleteMany` are emitted without one. A pattern that assumed the
   * generic reported those three as missing when they are not — which is worth
   * recording, because "the guard is stricter than the thing it guards" fails
   * the same way as a real defect and is diagnosed differently.
   */
  test.each(IMPLEMENTED)("%s is declared on the generated base", (operation) => {
    expect(
      new RegExp(`\\bstatic ${operation}\\s*[<(]`).test(source),
      `the compiler implements ${operation}, but the generated base declares no ` +
        `static ${operation} — an application cannot call it`,
    ).toBe(true);
  });

  /**
   * And nothing beyond them, so the emitter cannot advertise a query surface the
   * compiler will refuse at runtime.
   *
   * Two exclusions, both deliberate. `$`-prefixed names are framework internals,
   * kept out of an application's way by that prefix. `wrap` is not an operation
   * at all — it is the entity-level API `docs/orm-rows-and-entities.md` documents
   * as level 3, and it takes a row rather than query arguments.
   */
  test("the base declares no operation the compiler does not implement", () => {
    const declared = [...source.matchAll(/^\s*static (\w+)\s*[<(]/gm)]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("$") && name !== "wrap");

    const unknown = [...new Set(declared)].filter(
      (name) => !(IMPLEMENTED as string[]).includes(name),
    );

    expect(unknown, `the generated base declares ${unknown.join(", ")}`).toEqual([]);
  });
});
