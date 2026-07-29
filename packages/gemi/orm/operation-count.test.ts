import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Wherever the ORM's operation count is spelled out, it has to be the count.
 *
 * #182 found the number wrong in three places at once — "twelve" in
 * `active-record.ts`, "thirteen" in `strategy.ts` and `llms.txt`, "fourteen" in
 * `docs/orm.md` — against a union of fifteen. #183 fixed those three and put a
 * guard on the **list** rather than the number, reasoning that "a count can only
 * be wrong by one word, while a missing operation is a documented surface that
 * does not exist".
 *
 * That reasoning was right about severity and wrong about recurrence. Three more
 * survived the sweep, because they say "operations" without listing any:
 *
 *   packages/gemi/bin/orm/emit.ts   the twelve operations return plain objects
 *   plans/orm/README.md:218         zero changes to the twelve operations
 *   plans/orm/README.md:491         the thirteen operations
 *
 * Each was right when written and none moved when `count`, `aggregate` and
 * `groupBy` arrived — the same drift, from the same cause, in the places the
 * list-based guard cannot see. The one in `emit.ts` is load-bearing: it is the
 * argument for why a deliberately imprecise instance type is safe, and it
 * reaches that conclusion by enumerating what returns plain objects.
 *
 * So this guards the number, and the list guard stays. Neither subsumes the
 * other: a count can be right while an operation is missing from the list, and
 * the list can be complete while three files disagree about how many it holds.
 */

/** The count comes from the block `docs-scope.test.ts` pins to the compiler. */
const IMPLEMENTED_COUNT = (() => {
  const source = readFileSync(
    join(import.meta.dirname, "../../../docs/orm.md"),
    "utf8",
  );
  const at = source.search(/^\w+ operations, with Prisma's argument types verbatim:$/m);
  expect(at, "the operations block moved or was reworded").toBeGreaterThan(0);
  const fence = source.indexOf("```", at);
  const end = source.indexOf("```", fence + 3);
  return source
    .slice(fence + 3, end)
    .split(/\s+/)
    .filter(Boolean).length;
})();

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

const expected = NUMBER_WORDS[IMPLEMENTED_COUNT];

/**
 * The files that describe the ORM **as it is**.
 *
 * `plans/orm/README.md` is in scope because it is a living document, written in
 * the present tense and updated as the design moves. The numbered iteration
 * plans beside it — `plans/orm/08-eloquent-doorway.md` and its siblings — are
 * not: they record what was planned at a point in time, and "twelve" was true
 * when iteration 8 was written. Correcting those would be rewriting a dated
 * record to say something it did not say.
 *
 * `.test.ts` files are excluded because a test about a wrong number has to be
 * able to quote it. This file is the reason that matters.
 */
const walk = (dir: string, extensions: string[]): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, extensions));
    else if (extensions.some((ext) => entry.endsWith(ext)) && !entry.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
};

const ROOT = join(import.meta.dirname, "../../..");

const files = [
  ...walk(join(ROOT, "packages/gemi"), [".ts"]),
  ...walk(join(ROOT, "docs"), [".md", ".txt", ".html"]),
  join(ROOT, "plans/orm/README.md"),
];

/** `twelve operations`, `Fifteen operations` — a spelled-out count, not a digit. */
const COUNT = new RegExp(`\\b(${NUMBER_WORDS.join("|")})\\s+operations\\b`, "gi");

const claims = files.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(COUNT)].map((match) => ({
    file: file.slice(ROOT.length + 1),
    word: match[1].toLowerCase(),
    quote: match[0],
  })),
);

describe("the ORM's operation count agrees with itself", () => {
  test("the count was derived", () => {
    expect(IMPLEMENTED_COUNT).toBeGreaterThan(10);
    expect(expected).toBeDefined();
  });

  /** Without this the sweep passes by finding nothing. */
  test("the sweep found counts to check", () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  test.each(claims.map((claim) => [`${claim.file}: "${claim.quote}"`, claim] as const))(
    "%s",
    (_label, claim) => {
      expect(
        claim.word,
        `${claim.file} says "${claim.quote}", but the ORM implements ${IMPLEMENTED_COUNT}`,
      ).toBe(expected);
    },
  );
});
