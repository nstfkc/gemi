import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A benchmark figure quoted in the docs has to exist in the benchmarks.
 *
 * `docs/orm-rows-and-entities.md` said provenance costs "**about +100% on
 * SQLite and +40% on Postgres** — see `plans/orm/benchmarks.md`". The report's
 * provenance table has exactly one row:
 *
 *     | sqlite | 1000 | 418.9 | 833.0 | 99% |
 *
 * The SQLite half is right. The Postgres half is a number that appears nowhere
 * in the file it cites — `grep -rn "40%" plans/` finds nothing — because the
 * whole report was generated from a SQLite-only run (see #187).
 *
 * `docs/orm.md` refuses to quote a benchmark number at all, and says why:
 * "a number copied into prose drifts from its source the first time the source
 * is re-run". This page does quote them, which is defensible — the section's
 * point is that the default was chosen by measurement, and a reader deciding
 * whether to set `track: true` wants the magnitude. But quoting means the
 * numbers need checking, and nothing was checking them.
 *
 * The cost is concrete rather than cosmetic: `+40% on Postgres` reads as "this
 * is cheaper on your production database", which is the opposite of a decision
 * the report supports. This page is also embedded verbatim in
 * `docs/llms-full.txt`, so a tool repeats it confidently with nothing to bump
 * into.
 */
const ROOT = join(import.meta.dirname, "../../..");

/** The ORM's two documentation pages — the ones `llms-full.txt` embeds. */
const PAGES = ["orm.md", "orm-rows-and-entities.md"];

/** The dialects the committed run actually produced results for. */
const measured = new Set(
  (
    JSON.parse(
      readFileSync(join(ROOT, "plans/orm/benchmarks.json"), "utf8"),
    ) as Array<{ dialect?: string }>
  )
    .map((result) => result.dialect)
    .filter(Boolean),
);

/**
 * A figure attributed to a dialect: `+40% on Postgres`, `833µs on SQLite`,
 * `1.2× on Postgres`.
 *
 * Deliberately narrow. Both pages discuss dialect *behaviour* constantly — "a
 * `Date` binds as milliseconds on SQLite", "fine on SQLite; on Postgres:
 * current transaction is aborted" — and none of that is a measurement. Only a
 * number carrying a unit is.
 */
const FIGURE = /([+~]?\s*\d+(?:\.\d+)?)\s*(%|µs|×)\s+on\s+(SQLite|Postgres)/gi;

const figures = PAGES.flatMap((name) => {
  const text = readFileSync(join(ROOT, "docs", name), "utf8");
  return [...text.matchAll(FIGURE)].map((match) => ({
    page: name,
    value: Number(match[1].replace(/[+~\s]/g, "")),
    unit: match[2],
    dialect: match[3].toLowerCase(),
    quote: match[0],
  }));
});

describe("benchmark figures quoted in the docs are backed by the report", () => {
  /**
   * Without this the suite passes by matching nothing — which is how a guard
   * survives the deletion of the thing it guards.
   */
  test("the docs quote at least one benchmark figure", () => {
    expect(figures.length).toBeGreaterThan(0);
  });

  test("the report names at least one dialect", () => {
    expect(measured.size).toBeGreaterThan(0);
  });

  test.each(figures.map((figure) => [figure.quote, figure] as const))(
    "%s names a dialect the report measured",
    (_quote, figure) => {
      expect(
        measured,
        `${figure.page} quotes "${figure.quote}", but benchmarks.json has no ${figure.dialect} result`,
      ).toContain(figure.dialect);
    },
  );

  /**
   * ...and the one figure that maps to a table maps to the *right* row. Being
   * about the correct dialect is not enough: the number still has to be the
   * number, or a re-run moves the report and leaves the prose behind — which is
   * the failure `docs/orm.md` says happened three times inside the report
   * itself.
   *
   * Tolerance is 5 points because the prose rounds on purpose: "about +100%"
   * for a measured 99% is the honest way to quote it, and a doc forced to say
   * "+99%" would be stale after any re-run.
   */
  test("the provenance figure matches the provenance table", () => {
    const report = readFileSync(join(ROOT, "plans/orm/benchmarks.md"), "utf8");

    const start = report.indexOf("## Row provenance");
    expect(start, "the Row provenance section moved or was renamed").toBeGreaterThan(0);
    const section = report.slice(start, report.indexOf("\n## ", start + 1));

    const quoted = figures.filter(
      (figure) => figure.page === "orm-rows-and-entities.md" && figure.unit === "%",
    );
    expect(quoted.length, "the page stopped quoting a provenance percentage").toBeGreaterThan(0);

    for (const figure of quoted) {
      const row = section
        .split("\n")
        .find((line) => new RegExp(`^\\|\\s*${figure.dialect}\\b`).test(line));

      expect(row, `no ${figure.dialect} row in the provenance table`).toBeDefined();

      // The `added` column is the last cell: `| sqlite | 1000 | 418.9 | 833.0 | 99% |`
      const cells = row!.split("|").map((cell) => cell.trim()).filter(Boolean);
      const added = Number(cells[cells.length - 1].replace("%", ""));

      expect(
        Math.abs(added - figure.value),
        `the page says "${figure.quote}" but the table measured ${added}%`,
      ).toBeLessThanOrEqual(5);
    }
  });
});
