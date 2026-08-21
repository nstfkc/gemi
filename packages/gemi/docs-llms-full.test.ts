import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

import { buildLlmsFull, pageOrder } from "./scripts/build-llms-full";

/**
 * `docs/llms-full.txt` is every page concatenated, and it was maintained by
 * hand until this test existed.
 *
 * That is a losing arrangement, and the losses were real: eleven of the
 * twenty-eight pages had drifted by 0.57. Most of `middleware.md`'s
 * `rate-limit:N,W` section was missing, so was the `RateLimiter` facade, and
 * the `i18n.md` copy still taught `Dictionary.create` from `gemi/i18n` — an API
 * removed in 0.53 — while the page itself had documented `defineDictionary`
 * for four releases.
 *
 * Nothing caught any of it, and nothing could have. The only reader of this
 * file is a model being handed the documentation in one paste, and it has no
 * way to know the page it is quoting was rewritten. It answers confidently out
 * of whichever copy it was given.
 *
 * So the file is generated now, and this asserts the checked-in copy is what
 * the generator writes. It is `docs-imports.test.ts`'s neighbour by design:
 * that one checks every snippet in this file still names a real export, which
 * only means anything while the snippets are the current ones.
 */

const DOCS = join(import.meta.dirname, "../../docs");

test("docs/llms-full.txt is the pages concatenated, and current", async () => {
  const [committed, generated] = await Promise.all([
    readFile(join(DOCS, "llms-full.txt"), "utf8"),
    buildLlmsFull(),
  ]);

  expect(
    committed,
    "docs/llms-full.txt is stale. Regenerate it:\n\n" +
      "    bun packages/gemi/scripts/build-llms-full.ts\n",
  ).toBe(generated);
});

/**
 * The order comes from `llms.txt`, so a page absent from it would be silently
 * left out of the concatenation — present in `docs/`, missing from the one file
 * anybody pastes into a model.
 */
test("every documentation page is listed in llms.txt", async () => {
  const { readdirSync } = await import("node:fs");
  const pages = readdirSync(DOCS)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();

  expect([...(await pageOrder())].sort()).toEqual(pages);
});
