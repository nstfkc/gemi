import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Where the ORM's documentation sends readers, checked.
 *
 * `docs/orm-rows-and-entities.md` said, of `save`:
 *
 * > `save` compiles through the same path as any other write, so
 * > [policies](./authorization.md) scope it
 *
 * The link resolves — `authorization.md` exists — so nothing was wrong with it
 * in the way a link checker understands. But that page documents route-level
 * role middleware, and the only time it says "policy" is to state that gemi has
 * **no** policy auto-discovery. Model policies are in `docs/orm.md#policies`, a
 * section of its own.
 *
 * So a reader learning what `save` is scoped by clicked "policies" and landed
 * on HTTP middleware. `orm.md` links the same file correctly two hundred lines
 * later — "route-level authorization, which policies complement" — which is
 * what makes this a slip rather than a disagreement about where the content
 * belongs.
 *
 * Hence the third test below. The first two are the ordinary checks, and are
 * worth having for the anchors, but neither would have caught this: the target
 * existed and the page had headings. What was wrong is that the link promised a
 * concept the target does not document, and only a check that reads the label
 * can see that.
 */
const DOCS = join(import.meta.dirname, "../../../docs");

/** The ORM's own pages — the two `llms-full.txt` embeds. */
const PAGES = ["orm.md", "orm-rows-and-entities.md"];

/** GitHub's heading slug: lowercased, punctuation dropped, spaces hyphenated. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`'"“”’,.:;()[\]*_+/\\?!]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

const headings = (file: string) =>
  new Set(
    [...readFileSync(join(DOCS, file), "utf8").matchAll(/^#+\s+(.*)$/gm)].map(
      (match) => slug(match[1]),
    ),
  );

/** Every markdown link on the ORM pages that points inside the docs. */
const links = PAGES.flatMap((page) => {
  const text = readFileSync(join(DOCS, page), "utf8");
  return [...text.matchAll(/\[([^\]]+)\]\((\.\/[^)#]*|)(#[^)]+)?\)/g)]
    .filter((match) => match[2] || match[3])
    .map((match) => ({
      page,
      label: match[1],
      // A bare `#anchor` is a link into the page it appears on.
      target: match[2] ? match[2].replace(/^\.\//, "") : page,
      anchor: match[3]?.slice(1),
      raw: match[0],
    }));
});

describe("the ORM docs link where they say they do", () => {
  test("links were found", () => {
    expect(links.length).toBeGreaterThan(4);
  });

  test.each(links.map((link) => [link.raw, link] as const))(
    "%s points at a file that exists",
    (_raw, link) => {
      expect(existsSync(join(DOCS, link.target)), `${link.page} -> ${link.target}`).toBe(true);
    },
  );

  test.each(
    links.filter((link) => link.anchor).map((link) => [link.raw, link] as const),
  )("%s points at a heading that exists", (_raw, link) => {
    expect(
      [...headings(link.target)],
      `${link.page} -> ${link.target}#${link.anchor}`,
    ).toContain(link.anchor);
  });

  /**
   * The assertion that catches a link pointing somewhere real but wrong.
   *
   * Keyed on the label rather than the target, because the label is the promise
   * the reader is acting on. `policies` is the one worth pinning: it is the
   * concept most likely to be sent to `authorization.md` by reflex, since that
   * page owns the word for the HTTP layer while the ORM's meaning of it lives
   * in `orm.md`.
   *
   * Not a general "every label must be a heading somewhere" rule — most link
   * text is a sentence fragment, and that check would be noise rather than a
   * guard.
   */
  test.each(links.filter((link) => link.label.toLowerCase() === "policies"))(
    "a link labelled 'policies' goes to the section documenting them ($page)",
    (link) => {
      expect(
        [...headings(link.target)],
        `${link.page} sends "policies" to ${link.target}, which has no Policies section`,
      ).toContain("policies");
    },
  );
});
