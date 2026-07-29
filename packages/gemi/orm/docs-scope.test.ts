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

  /**
   * ...and the other direction, which nothing checked.
   *
   * The assertion above catches an error class the table forgot. It cannot
   * catch a row naming a class that no longer exists — and that is the half a
   * reader acts on, because the table is where you look to find out what there
   * is to catch. A row for a deleted error sends them to write a `catch` for
   * something no longer importable.
   *
   * The same asymmetry the operations list had until #226: a hand-written list
   * verified in one direction reads as though it were verified in both. Both
   * sets happen to agree today, at 21 — which is exactly when to pin it, rather
   * than after they stop agreeing.
   */
  test("the table names no error the ORM does not export", () => {
    const named = [...errorsTable.matchAll(/`([A-Z]\w*Error)`/g)].map(
      (match) => match[1],
    );

    expect(named.length, "no error names found — the table format moved").toBeGreaterThan(10);

    const unknown = [...new Set(named)].filter(
      (name) => !exported.includes(name),
    );

    expect(
      unknown,
      `the Errors table names ${unknown.join(", ")}, which gemi/orm does not export`,
    ).toEqual([]);
  });
});

/**
 * **`docs/llms-full.txt` carries the ORM pages verbatim**, and had stopped.
 *
 * That file is "every page concatenated for one-shot LLM context", served
 * verbatim at a stable URL by the docs workflow. `plans/orm/README.md` records
 * the intent — `orm.md` and `orm-rows-and-entities.md` were unreachable from
 * the four index files "until the doc pass. Both are now in all four."
 *
 * The ORM page's embedded copy had drifted to **626 lines against the source's
 * 1209** — roughly half. It predated the aggregate and `groupBy` sections, the
 * `Json` page, the composite-relation paragraphs and every correction in this
 * series, and it still said *"No `omit`"* under **Not in scope** while the
 * source documents `omit` at length.
 *
 * Worse than the same drift in `orm.md` would be, for the reason #145 gives
 * about "refused, but actually works": this file's audience is tools, which
 * repeat what they are given confidently and without bumping into the runtime
 * that would correct them.
 *
 * Compared exactly rather than loosely. A "close enough" check is what let it
 * reach half a page.
 */
describe("docs/llms-full.txt carries the ORM pages", () => {
  const full = readFileSync(join(import.meta.dirname, "../../../docs/llms-full.txt"), "utf8");

  /** The page's own body, from its `## Title` to the next `---` separator. */
  const embedded = (title: string) => {
    const start = full.indexOf(`\n## ${title}\n`);
    expect(start, `${title} is not in llms-full.txt`).toBeGreaterThan(0);
    const body = full.slice(start + 1);
    const end = body.indexOf("\n---");
    return (end === -1 ? body : body.slice(0, end)).trimEnd();
  };

  test.each(["orm.md", "orm-rows-and-entities.md"])("%s is embedded verbatim", (name) => {
    const source = readFileSync(join(import.meta.dirname, "../../../docs", name), "utf8").trimEnd();
    const [title] = source.split("\n");

    // The only difference the concatenation makes: the page's `#` title becomes
    // a `##` heading, because every page sits under one document.
    const expected = source.replace(title, `## ${title.replace(/^#\s*/, "")}`).trimEnd();

    expect(embedded(title.replace(/^#\s*/, ""))).toBe(expected);
  });
});

/**
 * **The operations `docs/orm.md` lists are the operations that exist.**
 *
 * The page introduces them with a count and a code block. The count had been
 * wrong, and had been wrong in three different ways at once across the
 * repository — "twelve" in `active-record.ts`, "thirteen" in `strategy.ts` and
 * `llms.txt`, "fourteen" in the page itself, against a union of **fifteen**.
 * Each was right when written and none moved when `count`, `aggregate` and
 * `groupBy` arrived.
 *
 * The list was complete throughout; only the prose around it drifted. That is
 * the milder failure, but it is the one a reader meets first, and I contributed
 * to it myself — #144 copied "thirteen" out of a comment without checking.
 *
 * So the guard is on the **list**, not the number: a count can only be wrong by
 * one word, while a missing operation is a documented surface that does not
 * exist, or an existing one nobody is told about.
 */
describe("docs/orm.md lists every operation", () => {
  const source = readFileSync(DOC, "utf8");

  /** The fenced block that follows the introduction. */
  const listed = (() => {
    const at = source.search(/^\w+ operations, with Prisma's argument types verbatim:$/m);
    expect(at, "the operations block moved or was reworded").toBeGreaterThan(0);
    const fence = source.indexOf("```", at);
    const end = source.indexOf("```", fence + 3);
    return source
      .slice(fence + 3, end)
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean);
  })();

  test("the block was found and holds names", () => {
    expect(listed.length).toBeGreaterThan(10);
  });

  test("it names exactly the operations the compiler implements", () => {
    expect([...listed].sort()).toEqual([...IMPLEMENTED].sort());
  });
});
