// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createStaticRenderCollector, island, StaticRenderContext } from "../../client/islands";
import { renderStaticDocument, type StaticDocumentHandle } from "../../testing/staticDocument";
import * as Feed from "./__fixtures__/islands/Feed";
import { ServerQueryStore } from "./ServerQueryStore";
import { injectIslands, spliceIslandSlots } from "./staticDocument";

/**
 * `useQuery` inside an island on a static page (#1155), in the browser: the
 * island hydrates from the data the document carries, with no fetch and no
 * mismatch. The documents are rendered the way a static view renders them
 * (`renderStatic`), down to `injectIslands`; `islandQueries.test.tsx` covers
 * the request side.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tagged = (key: string, mod: Record<string, unknown>) =>
  Object.assign(() => Promise.resolve(mod), { gemiIsland: key, gemiModule: mod }) as () => Promise<any>;

const FeedIsland = island(tagged("Feed", Feed)) as (props: { tag?: string }) => ReactElement;
const CountIsland = island(tagged("Feed", Feed), { export: "Count" }) as (props: { of?: string }) => ReactElement;

const server = (path: string, search: URLSearchParams) => {
  if (path === "/count") return { n: search.get("of") ? 7 : 42 };
  const tag = search.get("tag");
  return tag ? [{ id: 3, title: `Only ${tag}` }] : [{ id: 1, title: "First" }, { id: 2, title: "Second" }];
};

/**
 * A static document whose handler prefetched `prefetched`, rendered with no
 * `window`, as on the server: `useQuery` reads the request's store there.
 */
async function page(body: ReactElement, prefetched: string[]) {
  vi.stubGlobal("window", undefined);
  try {
    return await render(body, prefetched);
  } finally {
    vi.unstubAllGlobals();
  }
}

async function render(body: ReactElement, prefetched: string[]) {
  const store = new ServerQueryStore(async (path, _params, search) => server(path, search));
  for (const path of prefetched) store.ensure(path, {}, "prefetch");
  const collector = createStaticRenderCollector(
    async (element, identifierPrefix) => {
      const stream = await renderToReadableStream(element, { identifierPrefix });
      await stream.allReady;
      return await new Response(stream).text();
    },
    {},
    store,
  );
  const stream = await renderToReadableStream(
    createElement(StaticRenderContext.Provider, { value: collector }, body),
  );
  await stream.allReady;
  const html =
    `<!DOCTYPE html><html lang="en"><head><title>feed</title></head><body>` +
    `${spliceIslandSlots(await new Response(stream).text())}</body></html>`;
  return injectIslands(html, collector, () => ({ src: "/assets/Feed.js", preload: [] }), false, {
    identity: "site||",
    prefetch: "none",
  });
}

let handle: StaticDocumentHandle | undefined;

/** What the islands' queries ask the API for. */
const api = () => {
  const fetch = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const body = server(url.pathname.replace(/^\/api/, ""), url.searchParams);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

async function open(html: string) {
  handle = renderStaticDocument(html, { islands: { "/assets/Feed.js": Feed } });
  await settle();
  return handle;
}

/** What React reported, less the one warning only a test sees (see islandDictionary.browser.test.tsx). */
const errors = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((call) => !String(call[0]).startsWith("Detected multiple renderers"));

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const items = () => Array.from(document.querySelectorAll("li")).map((li) => li.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.dispose();
  handle = undefined;
  vi.restoreAllMocks();
});

describe("useQuery in an island, hydrating", () => {
  test("hydrates from the document's data: no fetch, no mismatch", async () => {
    const html = await page(createElement("main", null, createElement(FeedIsland)), ["/posts"]);
    expect(html).toContain("<li>First</li><li>Second</li>");
    expect(html).toContain('id="gemi-island-queries"');
    const fetch = api();
    const error = vi.spyOn(console, "error");

    await open(html);
    const list = document.querySelector("ul")!;
    expect(items()).toEqual(["First", "Second"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(errors(error)).toEqual([]);

    // Hydrated: the button works and the nodes are the server's.
    await act(() => document.querySelector("button")!.click());
    expect(document.querySelector("button")!.textContent).toBe("1");
    expect(document.querySelector("ul")).toBe(list);
    expect(fetch).not.toHaveBeenCalled();
    expect(errors(error)).toEqual([]);
  });

  test("a query read without suspense hydrates with its data too", async () => {
    const html = await page(createElement("main", null, createElement(CountIsland)), ["/count"]);
    expect(html).toContain("<output>42</output>");
    const fetch = api();
    const error = vi.spyOn(console, "error");

    await open(html);
    expect(document.querySelector("output")!.textContent).toBe("42");
    expect(fetch).not.toHaveBeenCalled();
    expect(errors(error)).toEqual([]);
  });

  test("a query the page did not prefetch is fetched once in the browser", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await page(createElement("main", null, createElement(CountIsland, { of: "drafts" })), []);
    expect(html).not.toContain("gemi-island-queries");
    expect(html).toContain("<output>…</output>");
    const fetch = api();
    const error = vi.spyOn(console, "error");

    await open(html);
    await settle();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/count?of=drafts"]);
    expect(document.querySelector("output")!.textContent).toBe("7");
    expect(errors(error)).toEqual([]);
  });
});
