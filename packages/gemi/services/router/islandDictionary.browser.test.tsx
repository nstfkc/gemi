// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import { createStaticRenderCollector, island, StaticRenderContext } from "../../client/islands";
import { __resetDictionaryRegistry, preloadDictionaries } from "../../i18n/dictionaryRegistry";
import { renderStaticDocument, type StaticDocumentHandle } from "../../testing/staticDocument";
import * as Cart from "./__fixtures__/islands/Cart";
import { injectIslands, spliceIslandSlots } from "./staticDocument";

/**
 * `useDictionary` inside an island on a static page (#1095), in the browser:
 * the island hydrates from the strings the document carries, with no fetch,
 * and re-renders with params only the browser knows. The documents are
 * rendered the way a static view renders them (`renderStatic`), down to
 * `injectIslands`; `islandDictionary.test.tsx` covers the locale a request
 * resolves to.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tagged = (key: string, mod: Record<string, unknown>) =>
  Object.assign(() => Promise.resolve(mod), { gemiIsland: key, gemiModule: mod }) as () => Promise<any>;

const VatLine = island(tagged("Cart", Cart)) as (props: { rate: number }) => ReactElement;
const PlainCounter = island(tagged("Cart", Cart), { export: "PlainCounter" }) as (props: {
  start: number;
}) => ReactElement;
const Amount = island(tagged("Cart", Cart), { export: "Amount" }) as () => ReactElement;
const Coupon = island(tagged("Cart", Cart), { export: "Coupon" }) as () => ReactElement;

/**
 * A static document in `locale`, with `navigation` on so pages can be swapped.
 * An empty `locale` is an app with none configured.
 */
async function page(locale: string, body: ReactElement, links = "") {
  await preloadDictionaries(locale);
  const collector = createStaticRenderCollector(
    async (element, identifierPrefix) => {
      const stream = await renderToReadableStream(element, { identifierPrefix });
      await stream.allReady;
      return await new Response(stream).text();
    },
    locale
      ? { currentLocale: locale, defaultLocale: "en-US", timeZone: "Europe/Istanbul" }
      : { defaultLocale: "en-US", timeZone: "Europe/Istanbul" },
  );
  const stream = await renderToReadableStream(
    createElement(StaticRenderContext.Provider, { value: collector }, body),
  );
  await stream.allReady;
  const html =
    `<!DOCTYPE html><html lang="${locale || "en"}"><head><title>${locale}</title></head><body>` +
    `${links}${spliceIslandSlots(await new Response(stream).text())}</body></html>`;
  return injectIslands(
    html,
    collector,
    () => ({ src: "/assets/Cart.js", preload: [] }),
    false,
    { identity: "shop||", prefetch: "none" },
  );
}

let handle: StaticDocumentHandle | undefined;

/** Opens `html` as a browser that has never loaded the dictionary would. */
async function open(html: string, pages: Record<string, string> = {}) {
  __resetDictionaryRegistry();
  Cart.loads.mockClear();
  handle = renderStaticDocument(html, { islands: { "/assets/Cart.js": Cart }, pages });
  await settle();
  return handle;
}

/**
 * What React reported through `console.error` (a hydration mismatch among
 * it), less one warning only a test sees: here the server and the browser
 * render `IslandI18nContext` in one process, which React's dev build flags as
 * two renderers sharing a context. A browser never runs the server's.
 */
const errors = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((call) => !String(call[0]).startsWith("Detected multiple renderers"));

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const outputs = () => Array.from(document.querySelectorAll("output")).map((o) => o.textContent);

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  vi.restoreAllMocks();
});
afterAll(() => {
  __resetDictionaryRegistry();
});

describe("useDictionary in an island, hydrating", () => {
  test("hydrates from the document's strings: no fetch, no mismatch", async () => {
    const html = await page("tr-TR", createElement("main", null, createElement(VatLine, { rate: 18 })));
    expect(html).toContain("<output>KDV (%18)</output>");
    const error = vi.spyOn(console, "error");

    await open(html);
    const output = document.querySelector("output")!;
    expect(output.textContent).toBe("KDV (%18)");
    expect(Cart.loads).not.toHaveBeenCalled();
    expect(errors(error)).toEqual([]);

    // Hydrated: the button works and the node is the server's.
    await act(() => document.querySelector("button")!.click());
    expect(document.querySelector("output")).toBe(output);
    expect(outputs()).toEqual(["KDV (%19)"]);
    await act(() => document.querySelector("button")!.click());
    expect(outputs()).toEqual(["KDV (%20)"]);
    expect(Cart.loads).not.toHaveBeenCalled();
    expect(errors(error)).toEqual([]);
  });

  test("an island that only formats hydrates in the page's locale", async () => {
    const html = await page("de-DE", createElement("main", null, createElement(Amount)));
    expect(html).toContain("<data>1.234,5</data>");
    const error = vi.spyOn(console, "error");

    await open(html);
    expect(document.querySelector("data")!.textContent).toBe("1.234,5");
    expect(errors(error)).toEqual([]);
  });

  test("an island that reads the dictionary only after a click renders in the page's locale", async () => {
    const html = await page("tr-TR", createElement("main", null, createElement(Coupon)));
    // The server render read no i18n; the page still carries its locale.
    expect(html).toContain('id="gemi-island-i18n"');
    expect(html).not.toContain("dictionaries");
    const error = vi.spyOn(console, "error");

    await open(html);
    await act(() => document.querySelector<HTMLButtonElement>("button.apply")!.click());
    await settle();
    expect(document.querySelector("p.applied")!.textContent).toBe("SAVE10 uygulandı");
    // Not in the document, so its chunk is loaded, in the page's locale.
    expect(Cart.loads.mock.calls).toEqual([["tr-TR"]]);
    expect(errors(error)).toEqual([]);
  });

  test("in an app with no locale, a page whose islands read no i18n hydrates as before", async () => {
    const html = await page("", createElement("main", null, createElement(PlainCounter, { start: 1 })));
    expect(html).not.toContain("gemi-island-i18n");
    const error = vi.spyOn(console, "error");

    await open(html);
    await act(() => document.querySelector<HTMLButtonElement>("button.plain")!.click());
    expect(document.querySelector("button.plain")!.textContent).toBe("2");
    expect(errors(error)).toEqual([]);
  });

  test("a page swapped in by static navigation hydrates in its own locale", async () => {
    const first = await page(
      "tr-TR",
      createElement("main", null, createElement(VatLine, { rate: 18 })),
      '<a href="/de">de</a>',
    );
    const second = await page("de-DE", createElement("main", null, createElement(VatLine, { rate: 7 })));
    const error = vi.spyOn(console, "error");

    const nav = await open(first, { "/de": second });
    expect(outputs()).toEqual(["KDV (%18)"]);
    expect((await act(() => nav.navigate("/de"))).kind).toBe("swap");
    await settle();
    expect(outputs()).toEqual(["MwSt. (7 %)"]);
    await act(() => document.querySelector("button")!.click());
    expect(outputs()).toEqual(["MwSt. (8 %)"]);
    expect(Cart.loads).not.toHaveBeenCalled();
    expect(errors(error)).toEqual([]);
  });
});
