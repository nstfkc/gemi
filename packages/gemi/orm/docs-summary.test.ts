import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The framework's one-paragraph summary names the ORM.
 *
 * Three files open with the same description of what gemi ships — `docs/README.md`,
 * `docs/llms.txt` and `docs/llms-full.txt` — and it enumerated eleven capabilities
 * without mentioning a query layer:
 *
 * > It ships **everything a typical web application needs** — class-based routing,
 * > a type-safe network layer, authentication and authorization, middleware, form
 * > validation, transactional email, background jobs, cron, object storage,
 * > real-time broadcasting, and i18n — so you spend time on product code instead
 * > of wiring libraries together.
 *
 * The sentence is a claim plus an enumeration, and the enumeration is what a
 * reader checks it against. A typical web application needs a database layer;
 * gemi ships one, with two documentation pages, its own Prisma generator and a
 * differential test suite against Prisma. Someone reading that list to decide
 * whether they must wire up Drizzle or the Prisma client themselves concludes
 * that they must — the exact opposite of the sentence's promise, and of the
 * subsystem's entire pitch.
 *
 * It costs most in `llms.txt`, whose whole purpose is to be the short answer a
 * tool reads before deciding what else to fetch: cron and i18n are named there
 * and the ORM is not, so "does gemi have an ORM?" answers itself wrongly from
 * the summary alone.
 *
 * `plans/orm/README.md` records the same concern one level down — neither ORM
 * page "was reachable from `docs/README.md`, `docs/index.html`, `docs/llms.txt`
 * or `docs/llms-full.txt` until the doc pass". The pages were linked; the
 * sentence describing what the framework ships was not updated with them.
 *
 * (`docs/index.html` carries no such summary, so it is not in the list below.)
 */
const DOCS = join(import.meta.dirname, "../../../docs");

const CARRIERS = ["README.md", "llms.txt", "llms-full.txt"];

/**
 * The summary, located by the first item in its list rather than by line number
 * or heading — that phrase is the stable part, and anchoring on it means a
 * reworded opening still finds the sentence instead of silently finding nothing.
 */
const summaryOf = (file: string) => {
  const text = readFileSync(join(DOCS, file), "utf8");
  const at = text.indexOf("class-based routing");
  expect(at, `${file} no longer contains the capability list`).toBeGreaterThan(0);

  // Back to the start of the sentence, forward to the end of the paragraph.
  const start = text.lastIndexOf("\n", at) + 1;
  const end = text.indexOf("\n", at);
  return text.slice(start, end === -1 ? undefined : end);
};

describe("the framework summary lists the ORM among what gemi ships", () => {
  test.each(CARRIERS)("%s carries the summary", (file) => {
    expect(summaryOf(file).length).toBeGreaterThan(200);
  });

  test.each(CARRIERS)("%s names the ORM in it", (file) => {
    expect(
      summaryOf(file),
      `${file} enumerates what gemi ships without naming the query layer`,
    ).toMatch(/\bORM\b/);
  });

  /**
   * The three are meant to carry one capability list. Checking they agree is
   * what stops the next edit fixing one and leaving the other two — which is
   * how this arose.
   *
   * Compared from the first item to the last, not to the end of the sentence:
   * `llms.txt` closes "as one integrated stack" where the other two close "so
   * you spend time on product code", and that difference is deliberate.
   */
  test("all three carry the same capability list", () => {
    const lists = CARRIERS.map((file) => {
      const summary = summaryOf(file);
      const list = summary.slice(summary.indexOf("class-based routing"));
      return list.slice(0, list.indexOf("i18n") + "i18n".length).replace(/\*\*/g, "");
    });

    expect(new Set(lists).size, `the summaries disagree:\n${lists.join("\n")}`).toBe(1);
  });
});
