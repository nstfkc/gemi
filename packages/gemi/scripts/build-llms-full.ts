import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Rebuilds `docs/llms-full.txt` — every documentation page in one file, for
 * dropping into an LLM's context in one paste.
 *
 * It is a concatenation and nothing more: `docs/README.md` as the header, then
 * each page in the order `llms.txt` lists it, each page's `#` title demoted to
 * `##` so the whole file has one heading level above its sections, joined by a
 * `---` rule.
 *
 * It exists because the file was maintained by hand and drifted. Five pages
 * were stale by 0.57 — most of a `middleware.md` section, the `RateLimiter`
 * facade, and an `i18n.md` that still documented `Dictionary.create` from
 * `gemi/i18n`, an API removed in 0.53. Nothing reported any of it: the file is
 * only ever read by a machine that was not there when the page changed, which
 * is the one kind of reader that cannot notice.
 *
 * `docs-llms-full.test.ts` asserts the checked-in file matches what this
 * writes, so the drift is a failed test rather than a stale answer.
 *
 * **Order comes from `llms.txt`**, which makes that file the index of record
 * and keeps the two from disagreeing about what exists. A page listed there and
 * absent from `docs/` fails loudly here rather than being silently skipped.
 */

const DOCS = join(import.meta.dirname, "../../../docs");

/** The pages, in the order `llms.txt` links them. `README.md` is the header. */
export async function pageOrder(): Promise<string[]> {
  const llms = await readFile(join(DOCS, "llms.txt"), "utf8");
  const order: string[] = [];

  for (const match of llms.matchAll(/\]\(https:\/\/nstfkc\.github\.io\/gemi\/([\w.-]+\.md)\)/g)) {
    const page = match[1];
    // `README.md` is linked from the "Optional" section as the human-readable
    // index. It is the header here, not a page in the body.
    if (page === "README.md" || order.includes(page)) continue;
    order.push(page);
  }

  return order;
}

export async function buildLlmsFull(): Promise<string> {
  const pages = ["README.md", ...(await pageOrder())];
  const sections: string[] = [];

  for (const page of pages) {
    const text = await readFile(join(DOCS, page), "utf8");
    const newline = text.indexOf("\n");
    const title = text.slice(0, newline).replace(/^#\s+/, "");
    const body = text.slice(newline + 1).trim();

    if (!text.startsWith("# ")) {
      throw new Error(`${page} does not open with an \`# H1\` title.`);
    }

    sections.push(`\n---\n\n## ${title}\n\n${body}\n`);
  }

  return sections.join("");
}

if (import.meta.main) {
  const contents = await buildLlmsFull();
  await writeFile(join(DOCS, "llms-full.txt"), contents);
  console.log(`wrote docs/llms-full.txt (${contents.length} bytes)`);
}
