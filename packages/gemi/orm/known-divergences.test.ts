import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A divergence from Prisma that the source records is also told to the reader.
 *
 * `dialect/postgres.ts` carries a comment headed **KNOWN DIVERGENCE**: Prisma
 * maps `DateTime` to `timestamp(3)`, and Bun's driver decodes that column
 * differently depending on which wire protocol carried the statement — which in
 * turn depends on whether the query binds a parameter. Measured against
 * Postgres 16:
 *
 *     TZ=UTC               findMany()            -> 2021-03-04T05:06:07.008Z
 *                          where id = $1         -> 2021-03-04T05:06:07.008Z
 *     TZ=America/New_York  findMany()            -> 2021-03-04T10:06:07.008Z
 *                          where id = $1         -> 2021-03-04T05:06:07.008Z
 *
 * Same row, same column, two instants, off by the machine's UTC offset. The
 * mitigation is a deployment setting — `TZ=UTC` — and `docs/orm.md` did not
 * mention `TZ`, `UTC` or time zones anywhere, while telling the reader that the
 * bare-JSON-number refusal was "the one shape where gemi diverges from Prisma".
 *
 * So the more severe of the two divergences was recorded only where the people
 * affected by it would never look, and the page that would have told them said
 * there was nothing else to know. CI runs under `TZ=UTC`, which is correct and
 * also means no test would ever have noticed.
 *
 * This does not try to detect divergences — it pins the two that exist to the
 * section that documents each, so removing the documentation fails rather than
 * quietly restoring the state above.
 */
const ROOT = join(import.meta.dirname, "../../..");
const DOC = readFileSync(join(ROOT, "docs/orm.md"), "utf8");

describe("divergences the source knows about are documented", () => {
  test("the page documents the Postgres TZ requirement", () => {
    expect(DOC).toMatch(/TZ=UTC/);
    // Named as a requirement rather than mentioned in passing: the failure is
    // silent and the reader has to act before they see it.
    expect(DOC).toMatch(/##\s+Run Postgres deployments with `TZ=UTC`/);
  });

  test("it says which queries are affected, not just that some are", () => {
    const section = DOC.slice(DOC.indexOf("## Run Postgres deployments"));
    // The distinction is the actionable part: whether the query binds a
    // parameter is what selects the protocol, and it is not otherwise guessable.
    expect(section).toMatch(/parameter/);
    expect(section).toMatch(/simple protocol/);
    expect(section).toMatch(/extended protocol/);
  });

  /**
   * The claim that started this. It is true of *writes*, and was written as
   * though it were true of everything.
   */
  /**
   * There is now one divergence, not two.
   *
   * This assertion has moved twice, and the sequence is the point. It began as
   * "the Json refusal is not called *the* only divergence", because the page
   * said the bare-scalar refusal was the one shape gemi differs on while the
   * `TZ` fault went unmentioned. It then required the narrowed wording, "the
   * one *write* shape". Lifting the boundary removed the write divergence
   * outright, so what is left to assert is that the page claims no divergence
   * it no longer has.
   *
   * Kept rather than deleted with the sentence it guarded: the failure it
   * exists to catch is a page describing a divergence that is not there, and
   * that is as wrong in this direction as it was in the other.
   */
  test("the page does not claim a Json divergence it no longer has", () => {
    expect(DOC).not.toMatch(/shape where gemi diverges from Prisma/);
    expect(DOC).not.toMatch(/bare JSON number or boolean is refused/);
  });

  /**
   * And the source comment stays the authority it claims to be: if the
   * `KNOWN DIVERGENCE` note is deleted or moved, this stops matching and the
   * documentation above is left describing something nothing records.
   */
  test("the dialect still carries the note the docs are derived from", () => {
    const dialects = join(ROOT, "packages/gemi/orm/dialect");
    const sources = readdirSync(dialects)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(join(dialects, file), "utf8"));

    expect(sources.some((source) => source.includes("KNOWN DIVERGENCE"))).toBe(true);
  });

  /**
   * The third of the kind, and the only one gemi *fixed* rather than recorded —
   * which is exactly why the page still has to say it.
   *
   * `$1::jsonb` bound a JS string as a jsonb **string** under Bun where Prisma
   * bound the parsed document, so a byte-identical raw statement changed meaning
   * on a port. `json-param.ts` retypes the parameter through `text`, and a
   * reader who does not know that will write `${JSON.stringify(v)}::jsonb`
   * against `DB.sql` — Bun's own tag, which this does not reach — or read the
   * two paths' treatment of a string as a bug. The fix is not self-describing
   * from the call site, so the page carries it.
   */
  test("the page tells a porter what a raw ::jsonb parameter does", () => {
    expect(DOC).toMatch(/###\s+A `::jsonb` cast you write types the parameter as `text`/);

    const section = DOC.slice(DOC.indexOf("### A `::jsonb` cast you write"));
    // The three things a porter cannot recover from the call site: the spelling
    // that fixes it, the operator whose meaning silently changed, and the one
    // shape left uncovered.
    expect(section).toMatch(/\$1::text::jsonb/);
    expect(section).toMatch(/array\s*\n?\s*concatenation, not a merge/);
    expect(section).toMatch(/bare `\$1`/);
  });

  test("the source the section is derived from is still there", () => {
    const source = readFileSync(
      join(ROOT, "packages/gemi/orm/json-param.ts"),
      "utf8",
    );

    // The measurement, not the prose: if the table goes, the page above is
    // describing driver behaviour that nothing in the repository records.
    expect(source).toMatch(/prisma\s+bun/i);
    expect(source).toMatch(/\$1::text::jsonb/);
  });

  /**
   * The fourth, found by reviewing #407 rather than by using the ORM — which is
   * why it needs pinning hardest.
   *
   * A bare `null` in a filter means `is null` on every column type, and that is
   * Prisma's reading on every column type *but* `Json`. There Prisma reads it
   * as the JSON value `null` — the same thing it reads at a path — so
   * `{ metadata: { equals: null } }` returns the SQL-NULL rows here and the
   * JSON-null rows there. Disjoint sets, identical data, nothing raised.
   *
   * **It was nearly documented backwards.** #407 gave a bare `null` at a *path*
   * the `JsonNull` reading, correctly and to match the oracle, and then
   * explained the column/path difference as Prisma's own asymmetry. It is not:
   * Prisma has no asymmetry, gemi has the divergence, and prose asserting the
   * opposite would have told a reader the wrong row set was the right one. That
   * is the failure this file exists to prevent, arriving through a comment
   * rather than through silence.
   *
   * Not fixed, deliberately: the column path is released behaviour for every
   * `Json` filter and wants its own change and its own differential cases.
   * Recorded instead, in the three places a reader might start from.
   */
  test("the page documents the bare-null-on-a-Json-column divergence", () => {
    expect(DOC).toMatch(
      /##\s+A bare `null` on a `Json` column means `DbNull` here and `JsonNull` on Prisma/,
    );

    const section = DOC.slice(DOC.indexOf("## A bare `null` on a `Json` column"));
    // The three things a reader cannot recover from the call site: which rows
    // each side returns, that it is silent, and the spelling that avoids it.
    expect(section).toMatch(/SQL-NULL rows/);
    expect(section).toMatch(/JSON-null rows/);
    expect(section).toMatch(/equals: DbNull/);
    // ...and that the *path* is the case that agrees, so the section cannot be
    // read as condemning the thing #407 added.
    expect(section).toMatch(/agrees with Prisma/);
  });

  test("the compiler still carries the note that section is derived from", () => {
    const source = readFileSync(
      join(ROOT, "packages/gemi/orm/compile/where.ts"),
      "utf8",
    );

    expect(source).toMatch(/KNOWN DIVERGENCE — a bare `null` on a `Json` column/);
    // The measurement rather than the prose, for the reason the `json-param.ts`
    // check above gives: if the two predicates go, the page is describing
    // behaviour nothing in the repository records.
    expect(source).toMatch(/"payload"::jsonb = \$1/);
    expect(source).toMatch(/"payload" is null/);
  });
});
