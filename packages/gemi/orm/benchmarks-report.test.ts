import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `plans/orm/benchmarks.md` and its `.json` have to agree about which dialects
 * were actually measured.
 *
 * The report is generated — its own header says "Regenerate rather than
 * editing" — and `docs/orm.md` sends readers to it twice, once for "exact
 * multipliers, the method, and what the measurement does **not** establish"
 * and once for "the reasoning behind the lateral default". `lateral.ts` and
 * `strategy.ts` cite it from source as well.
 *
 * The committed report claimed both sides of the same question. Three lines
 * apart it said *"Deliverable 2 (lateral + `json_agg`) **was not evaluated**:
 * Postgres was not measured"* and *"**Postgres was measured over loopback**,
 * so every Postgres round trip here is optimistic"*, and it quoted a Postgres
 * point read and depth-2 include "at 0.82× and 0.94×" — while `benchmarks.json`
 * held nine results, every one of them `"dialect": "sqlite"`, and the tables
 * contained no Postgres row at all.
 *
 * Only the first of those was generated conditionally. The rest were static
 * strings in the report array, emitted whether or not Postgres ran — which is
 * exactly the failure `docs/orm.md` describes as the reason the numbers are not
 * repeated there: "a number copied into prose drifts from its source the first
 * time the source is re-run, which happened three times inside that report
 * before its own sentences were derived rather than written." These were the
 * sentences that never made that transition.
 *
 * A reader cannot resolve a report that contradicts itself, and the half that
 * is wrong is the confident half. So this asserts the property directly against
 * the committed artifacts rather than against the generator: whatever code path
 * emitted a claim, a claim about a dialect that has no data is caught here.
 */
const PLANS = join(import.meta.dirname, "../../../plans/orm");

/** The dialects the run actually produced results for. */
const measured = (() => {
  const results = JSON.parse(
    readFileSync(join(PLANS, "benchmarks.json"), "utf8"),
  ) as Array<{ dialect?: string }>;

  expect(Array.isArray(results), "benchmarks.json is not an array").toBe(true);
  expect(results.length).toBeGreaterThan(0);

  return new Set(results.map((result) => result.dialect).filter(Boolean));
})();

const report = readFileSync(join(PLANS, "benchmarks.md"), "utf8");

describe("plans/orm/benchmarks.md reports only dialects it measured", () => {
  test("the data names at least one dialect", () => {
    expect(measured.size).toBeGreaterThan(0);
  });

  /**
   * Every dialect appearing in a table row has to be one the data knows about.
   * The rows are the part a reader trusts most, so a row for an unmeasured
   * dialect is the worst version of this.
   */
  test("no table row names a dialect the data does not have", () => {
    const rows = report
      .split("\n")
      .filter((line) => /^\|\s*(sqlite|postgres)\b/.test(line))
      .map((line) => line.split("|")[1].trim());

    expect(rows.length, "no dialect rows found — the table format moved").toBeGreaterThan(0);

    for (const dialect of new Set(rows)) {
      expect(measured, `benchmarks.md has ${dialect} rows`).toContain(dialect);
    }
  });

  /**
   * ...and the prose has to hold the same line.
   *
   * A line is read as *asserting a measurement* when it names the dialect
   * alongside a figure (`0.82×`, `+350µs`, `17%`) or says it "was measured".
   * Lines about the measurement's **absence** are what the report should say
   * when a dialect did not run, so they are excluded by their own wording —
   * "was not measured", "not evaluated", "not in this run", and the instruction
   * to set the URL that would make it run.
   *
   * Deliberately not a whole-document regex: reporting the offending line is
   * what makes the failure actionable, since the fix is always to gate that one
   * sentence in `bench/run.ts` the way the deliverable-2 caveat already is.
   */
  test.each([...(["sqlite", "postgres"] as const)])(
    "no sentence claims a %s figure unless that dialect ran",
    (dialect) => {
      if (measured.has(dialect)) return;

      const absence =
        /not measured|not evaluated|not in this run|require|set `BENCH_/i;
      const figure = /\d+(\.\d+)?\s*(µs|×|%)|\bwas measured\b/;

      const claims = report
        .split("\n")
        .filter((line) => new RegExp(dialect, "i").test(line))
        .filter((line) => figure.test(line) && !absence.test(line));

      expect(claims, `${dialect} has no data, but the report states figures for it`).toEqual([]);
    },
  );

  /**
   * ...and a ratio the prose quotes has to be a ratio the run produced.
   *
   * The dialect check above is necessary and not sufficient. The report said
   * "the Postgres point read and depth-2 include come out at **0.82× and
   * 0.94×**"; gating that sentence on whether Postgres ran stops it appearing
   * beside "Postgres was not measured", but a run that *did* measure Postgres
   * would still have been handed those two numbers whatever it measured. The
   * gate fixes the contradiction; only deriving the figure fixes the figure.
   *
   * Restricted to ratios **below 1.00×**, which is the precise claim worth
   * pinning: "gemi came out faster than hand-written SQL here" is the one
   * conclusion the report explicitly says is never real, so a sub-1 ratio in
   * prose is either a live measurement worth reading or a leftover. Ratios
   * above 1 are ordinary results and quoting them is not this failure mode.
   *
   * Table cells are skipped — they *are* the data, so checking them against
   * the data they were rendered from proves nothing.
   */
  test("every sub-1.00× ratio in the prose is one the run measured", () => {
    const ratios = new Set(
      (
        JSON.parse(
          readFileSync(join(PLANS, "benchmarks.json"), "utf8"),
        ) as Array<{ raw?: { p50: number }; gemi: { total: { p50: number } } }>
      )
        .filter((result) => (result.raw?.p50 ?? 0) > 0)
        .map((result) => (result.gemi.total.p50 / result.raw!.p50).toFixed(2)),
    );

    const quoted = report
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("|"))
      .flatMap((line) => [...line.matchAll(/\b0\.\d{2}×/g)].map((m) => m[0]));

    for (const ratio of quoted) {
      expect(
        [...ratios],
        `the report quotes ${ratio}, which no result in benchmarks.json produces`,
      ).toContain(ratio.replace("×", ""));
    }
  });
});
