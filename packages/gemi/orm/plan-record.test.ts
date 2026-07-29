import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { Model } from "./Model";
import * as orm from "./index";

/**
 * The design record does not call shipped API "future".
 *
 * `plans/orm/README.md` is the ORM's design record — the document the invariants
 * come from, cited by name from `strategy.ts`, `lateral.ts`, `nested-writes.ts`
 * and `order-relation.ts`. It is a living document: it has a "How the stack
 * landed" section, and a later line reads "Both are now in all four".
 *
 * Two of its invariants still described shipped API as forthcoming:
 *
 *   invariant 3   a future `ActiveRecordModel` base overrides `$shape`
 *   invariant 5   enabling a future `User.save(row)` that diffs against …
 *                 Iterations 1–7 only need the seam to exist; iteration 8
 *                 fills it in.
 *
 * `ActiveRecordModel` is exported from `orm/index.ts:2`. `Model.save` is a
 * static at `Model.ts:204`. Iteration 8 landed, and the same document's own
 * status table says so — "#53 … opt-in provenance, `save(row)`, `wrap`".
 *
 * So the document contradicts itself, and the half a reader is more likely to
 * act on is the invariant: someone reading it to find out whether provenance
 * exists is told it is a seam awaiting a later iteration, and would go and build
 * what is already there.
 *
 * This is guardable rather than merely fixable because the claim names the API.
 * A sentence calling `X` future can be checked against whether `X` exists.
 */
const RECORD = join(import.meta.dirname, "../../../plans/orm/README.md");

/**
 * `a future \`ActiveRecordModel\``, `a future \`User.save(row)\`` — a backticked
 * identifier the prose puts in the future.
 *
 * Only this phrasing, deliberately. "every future tier becomes a rewrite" two
 * lines below one of these names no API and is not a claim about what exists;
 * matching loosely on the word would flag it and teach the next person to work
 * around the guard.
 */
const FUTURE = /a future `([A-Za-z_][\w.]*)(\([^`]*\))?`/g;

const claimed = [...readFileSync(RECORD, "utf8").matchAll(FUTURE)].map(
  (match) => ({ name: match[1], quote: match[0] }),
);

/**
 * Is the ORM already shipping this?
 *
 * Two forms appear: a bare export (`ActiveRecordModel`) and a call on a model
 * (`User.save(row)`), which names a static on the model base rather than a
 * member of any particular model.
 */
const ships = (name: string) => {
  if (name in orm) return true;
  const [, member] = name.split(".");
  return Boolean(member) && typeof (Model as never as Record<string, unknown>)[member] === "function";
};

describe("plans/orm/README.md does not call shipped API future", () => {
  /**
   * The two the fix removed are the only two the phrasing ever had, so an empty
   * sweep is the expected state — but a *silently* empty one would also be what
   * a moved or reworded file produces. Anchored on a line that has to survive
   * any rewording of the invariants for the document to still be that document.
   */
  test("the record was found and read", () => {
    const source = readFileSync(RECORD, "utf8");
    expect(source).toContain("# gemi ORM");
    expect(source.length).toBeGreaterThan(10_000);
  });

  test("the sweep is anchored on a real pattern", () => {
    const sample = "enabling a future `User.save(row)` that diffs";
    expect([...sample.matchAll(FUTURE)].map((m) => m[1])).toEqual(["User.save"]);
  });

  test.each(claimed.map((claim) => [claim.quote, claim] as const))(
    "%s is not something the ORM already ships",
    (_quote, claim) => {
      expect(
        ships(claim.name),
        `the design record calls ${claim.name} future, but the ORM exports it`,
      ).toBe(false);
    },
  );
});
