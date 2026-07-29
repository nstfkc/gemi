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
});
