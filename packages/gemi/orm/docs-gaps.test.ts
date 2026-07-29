import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A gap the documentation names by issue number has not already been closed.
 *
 * `docs/orm.md` carried a callout headed **Known gap (#98)**: a child scoped on
 * its own foreign key "cannot use any relation operand that writes that key,
 * including `connect`, unless it also declares an `onUpdate`".
 *
 * #98 had landed. `nested-write-policies.test.ts` says so in as many words —
 * *"**#98 has landed, so this flipped** — as the pin it replaces said it
 * should"* — and pins both operands succeeding. So the page told a reader to
 * work around something the suite had already proved was fixed, which is #145's
 * failure with the sign reversed: there, the docs called an implemented
 * operation out of scope; here, they call a closed gap open.
 *
 * The costly direction, because a documented limitation is *believed*. A reader
 * does not try `connect` to see whether the note is stale — they restructure
 * around it, or add an `onUpdate` that grants more than they meant to.
 *
 * This cannot ask GitHub whether an issue is closed, and should not: a test
 * that needs the network fails for reasons that have nothing to do with the
 * code. It checks the contradiction *inside the repository* instead — a gap the
 * docs name, and a test asserting that same number has landed, cannot both be
 * right.
 */
const ROOT = join(import.meta.dirname, "../../..");

/** Issue numbers `docs/orm.md` presents as an open gap. */
const claimedGaps = (() => {
  const pages = ["orm.md", "orm-rows-and-entities.md"].map((name) =>
    readFileSync(join(ROOT, "docs", name), "utf8"),
  );

  return pages.flatMap((page) =>
    [...page.matchAll(/known gap \(#(\d+)\)/gi)].map((match) => match[1]),
  );
})();

/** Issue numbers a test says have landed. */
const landed = (() => {
  const roots = [
    join(ROOT, "packages/gemi/orm"),
    join(ROOT, "templates/saas-starter/app/models"),
  ];

  const found = new Set<string>();
  for (const dir of roots) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      for (const match of source.matchAll(/#(\d+) has landed/g)) {
        found.add(match[1]);
      }
    }
  }
  return found;
})();

describe("the docs do not name a gap the suite says is closed", () => {
  /**
   * Both sides have to be readable for the comparison to mean anything. An
   * empty `landed` set would make this pass by finding nothing — which is how
   * the state it exists to catch would look.
   */
  test("the phrase a test uses to record a landing is still in use", () => {
    expect(landed.size).toBeGreaterThan(0);
  });

  test("no documented gap has a test saying it landed", () => {
    const contradicted = claimedGaps.filter((issue) => landed.has(issue));

    expect(
      contradicted,
      `docs/orm.md calls #${contradicted.join(", #")} an open gap, but a test ` +
        `in this repository says it has landed`,
    ).toEqual([]);
  });
});
