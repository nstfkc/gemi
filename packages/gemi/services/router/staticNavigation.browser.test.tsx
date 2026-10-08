// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createStaticRenderCollector, island, StaticRenderContext } from "../../client/islands";
import { onStaticNavigate } from "../../client/staticNavigation";
import {
  renderStaticDocument,
  type StaticDocumentHandle,
  type StaticDocumentOptions,
} from "../../testing/staticDocument";
import * as CounterModule from "./__fixtures__/islands/Counter";
import * as ScrollLockModule from "./__fixtures__/islands/ScrollLock";
import { spliceIslandSlots } from "./staticDocument";

/**
 * The navigation runtime of `.static({ navigation })` (#865) in a DOM, through
 * `gemi/testing`'s `renderStaticDocument`, the way an app would test its site.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tagged = (key: string, mod: Record<string, unknown>) =>
  Object.assign(() => Promise.resolve(mod), { gemiIsland: key, gemiModule: mod }) as () => Promise<any>;

const Counter = island(tagged("Counter", CounterModule)) as (props: {
  start: number;
  label: string;
}) => ReactElement;
const ScrollLock = island(tagged("ScrollLock", ScrollLockModule)) as (props: {
  label: string;
}) => ReactElement;

/** The entry URL each island's table entry names, and what it imports. */
const islandModules = { "/assets/Counter.js": CounterModule, "/assets/ScrollLock.js": ScrollLockModule };

const ORIGIN = "http://localhost:3000";

interface PageSpec {
  title: string;
  /** Plain HTML for the body, or React (islands included) rendered as a static view does. */
  body: string | ReactElement;
  identity?: string;
  head?: string;
  lang?: string;
  bodyAttributes?: string;
  stylesheet?: string;
}

/** A whole static document, as the server sends one with `navigation` on. */
async function page(spec: PageSpec): Promise<string> {
  let body = spec.body;
  let table = "";
  if (typeof body !== "string") {
    const collector = createStaticRenderCollector(async (element, identifierPrefix) => {
      const stream = await renderToReadableStream(element, { identifierPrefix });
      await stream.allReady;
      return await new Response(stream).text();
    });
    const stream = await renderToReadableStream(
      createElement(StaticRenderContext.Provider, { value: collector }, body),
    );
    await stream.allReady;
    body = spliceIslandSlots(await new Response(stream).text());
    if (collector.islands.length) {
      const entries = collector.islands.map((entry) => ({
        s: `/assets/${entry.module}.js`,
        e: entry.export,
        l: entry.load,
      }));
      table = `<script type="application/json" id="gemi-islands">${JSON.stringify({ i: entries })}</script>`;
    }
  }
  return (
    `<!DOCTYPE html><html lang="${spec.lang ?? "en"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${spec.title}</title>` +
    `<meta name="gemi-static" content="${spec.identity ?? "site/Layout|b1|"}">${spec.head ?? ""}</head>` +
    `<body ${spec.bodyAttributes ?? ""}><style id="app.css">${spec.stylesheet ?? "body{margin:0}"}</style>` +
    `${body}${table}<script type="module">/* the runtime */</script></body></html>`
  );
}

let handle: StaticDocumentHandle | undefined;

async function start(first: PageSpec, options: StaticDocumentOptions = {}) {
  handle = renderStaticDocument(await page(first), {
    url: "/a",
    islands: islandModules,
    ...options,
  });
  return handle;
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const nav = (links: string) => `<nav>${links}</nav>`;

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("which clicks the runtime takes", () => {
  const links = [
    '<a href="/b" id="plain">b</a>',
    '<a href="https://elsewhere.dev/b">external</a>',
    '<a href="#top">hash</a>',
    '<a href="#">empty hash</a>',
    '<a href="/a#top">same page hash</a>',
    '<a href="/b" target="_blank">blank</a>',
    '<a href="/b?self" target="_self">self</a>',
    '<a href="/b?download" download>download</a>',
    '<a href="/b?external" rel="noopener external">rel external</a>',
    '<div data-gemi-reload><a href="/b?reload">reload</a></div>',
    '<a href="mailto:hi@gemi.dev">mail</a>',
  ].join("");
  const next = () => page({ title: "B", body: "<main><h1>B</h1></main>" });

  test("a same-origin link: fetched and swapped in", async () => {
    const b = await next();
    const doc = await start({ title: "A", body: nav(links) }, { pages: { "/b": b, "/b?self": b } });

    expect(await doc.navigate("/b")).toEqual({ kind: "swap", url: `${ORIGIN}/b` });
    expect(location.pathname).toBe("/b");
    expect(doc.requests).toEqual([`${ORIGIN}/b`]);
  });

  test("target=_self counts as a plain link", async () => {
    const doc = await start({ title: "A", body: nav(links) }, { pages: { "/b?self": await next() } });
    expect((await doc.navigate("/b?self")).kind).toBe("swap");
  });

  test.each([
    ["https://elsewhere.dev/b", "another origin"],
    ["#top", "a hash on this page"],
    ["#", "an empty hash"],
    ["/a#top", "this page's path with a hash"],
    ["/b?download", "download"],
    ["/b?external", "rel=external"],
    ["/b?reload", "data-gemi-reload on an ancestor"],
    ["mailto:hi@gemi.dev", "another scheme"],
  ])("%s (%s) is left to the browser", async (href) => {
    const doc = await start({ title: "A", body: nav(links) }, { pages: { "/b": await next() } });

    expect(await doc.navigate(href)).toEqual({ kind: "native" });
    expect(doc.requests).toEqual([]);
  });

  test("target=_blank is left to the browser", async () => {
    const doc = await start({ title: "A", body: nav('<a href="/b" target="_blank">b</a>') });
    expect(await doc.navigate("/b")).toEqual({ kind: "native" });
  });

  test.each([
    [{ ctrlKey: true }],
    [{ metaKey: true }],
    [{ shiftKey: true }],
    [{ altKey: true }],
    [{ button: 1 }],
  ])("a click with %o is left to the browser", async (init) => {
    const doc = await start({ title: "A", body: nav(links) });
    expect(await doc.navigate("/b", init)).toEqual({ kind: "native" });
    expect(doc.requests).toEqual([]);
  });

  test("a click another handler prevented is left alone", async () => {
    const doc = await start({ title: "A", body: nav(links) });
    document.getElementById("plain")!.addEventListener("click", (event) => event.preventDefault());
    expect(await doc.navigate("/b")).toEqual({ kind: "native" });
    expect(doc.requests).toEqual([]);
  });

  test("cancelling gemi:before-navigate leaves the click to the browser", async () => {
    const doc = await start({ title: "A", body: nav(links) });
    const seen: string[] = [];
    const cancel = (event: Event) => {
      seen.push((event as CustomEvent).detail.url);
      event.preventDefault();
    };
    document.addEventListener("gemi:before-navigate", cancel);

    const result = await doc.navigate("/b");
    document.removeEventListener("gemi:before-navigate", cancel);
    expect(result).toEqual({ kind: "native" });
    expect(seen).toEqual([`${ORIGIN}/b`]);
    expect(doc.requests).toEqual([]);
  });
});

describe("the swap", () => {
  test("replaces the title, the managed head tags, <html lang> and the body", async () => {
    const doc = await start(
      {
        title: "A",
        lang: "en",
        head:
          '<meta name="description" content="about a"><link rel="canonical" href="/a">' +
          '<meta property="og:title" content="A"><link rel="preload" href="/own.css" as="style">' +
          '<link rel="modulepreload" href="/assets/react.js">',
        bodyAttributes: 'class="page-a"',
        body: nav('<a href="/b">b</a>') + "<main><h1>A</h1></main>",
      },
      {
        pages: {
          "/b": await page({
            title: "B",
            lang: "de",
            head:
              '<meta name="description" content="about b"><link rel="canonical" href="/b">' +
              '<script type="application/ld+json">{"@type":"Thing"}</script>' +
              '<link rel="modulepreload" href="/assets/react.js"><link rel="modulepreload" href="/assets/Menu.js">',
            bodyAttributes: 'class="page-b" data-x="1"',
            body: "<main><h1>B</h1><p>second</p></main>",
          }),
        },
      },
    );
    const style = document.getElementById("app.css");

    await doc.navigate("/b");

    expect(document.title).toBe("B");
    expect(document.documentElement.lang).toBe("de");
    expect(document.querySelector('meta[name="description"]')!.getAttribute("content")).toBe("about b");
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.querySelector('link[rel="canonical"]')!.getAttribute("href")).toBe("/b");
    expect(document.querySelector('meta[property="og:title"]')).toBeNull();
    expect(document.querySelector('script[type="application/ld+json"]')!.textContent).toContain("Thing");
    // The next page's eager islands' preloads are added, once.
    expect(
      Array.from(document.querySelectorAll('link[rel="modulepreload"]'), (l) => l.getAttribute("href")),
    ).toEqual(["/assets/react.js", "/assets/Menu.js"]);
    // Head tags gemi does not own stay.
    expect(document.querySelector('link[rel="preload"][as="style"]')).not.toBeNull();
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    expect(document.body.className).toBe("page-b");
    expect(document.body.dataset.x).toBe("1");
    expect(document.querySelector("main")!.textContent).toBe("Bsecond");
    expect(document.querySelector("nav")).toBeNull();
    // The stylesheet is the same one, not parsed again.
    expect(document.getElementById("app.css")).toBe(style);
  });

  test("focuses the first h1 and announces the new title", async () => {
    const doc = await start(
      { title: "A", body: nav('<a href="/b">b</a>') },
      { pages: { "/b": await page({ title: "Page B", body: "<main><h1>B</h1></main>" }) } },
    );

    await doc.navigate("/b");

    const h1 = document.querySelector("h1")!;
    expect(document.activeElement).toBe(h1);
    expect(h1.getAttribute("tabindex")).toBe("-1");
    h1.blur();
    expect(h1.hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("Page B");
  });

  test("a link with a hash scrolls to and focuses its target", async () => {
    const doc = await start(
      { title: "A", body: nav('<a href="/b#details">b</a>') },
      {
        pages: {
          "/b": await page({ title: "B", body: '<h1>B</h1><section id="details">d</section>' }),
        },
      },
    );
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");

    await doc.navigate("/b#details");

    expect(location.href).toBe(`${ORIGIN}/b#details`);
    expect(scrolled.mock.contexts[0]).toBe(document.getElementById("details"));
    expect(document.activeElement).toBe(document.getElementById("details"));
  });

  test("keeps data-gemi-persist elements the next page also has", async () => {
    const doc = await start(
      {
        title: "A",
        body: '<div data-gemi-persist="player"><audio></audio></div>' + nav('<a href="/b">b</a>'),
      },
      {
        pages: {
          "/b": await page({
            title: "B",
            body: '<main><div data-gemi-persist="player">placeholder</div><h1>B</h1></main>',
          }),
        },
      },
    );
    const player = document.querySelector('[data-gemi-persist="player"]');

    await doc.navigate("/b");

    expect(document.querySelector('[data-gemi-persist="player"]')).toBe(player);
    expect(player!.parentElement!.tagName).toBe("MAIN");
    expect(document.body.textContent).not.toContain("placeholder");
  });

  test("follows a redirect to the final URL", async () => {
    const doc = await start(
      { title: "A", body: nav('<a href="/old">old</a>') },
      { pages: { "/old": { html: await page({ title: "New", body: "<h1>new</h1>" }), url: "/new" } } },
    );

    expect(await doc.navigate("/old")).toEqual({ kind: "swap", url: `${ORIGIN}/new` });
    expect(location.pathname).toBe("/new");
  });

  test("dispatches gemi:page-load, and onStaticNavigate replays the current page", async () => {
    const doc = await start(
      { title: "A", body: nav('<a href="/b">b</a>') },
      { pages: { "/b": await page({ title: "B", body: "<h1>B</h1>" }) } },
    );
    const pages: unknown[] = [];
    const stop = onStaticNavigate((p) => pages.push(p));

    await doc.navigate("/b");
    stop();

    expect(pages).toEqual([
      { url: `${ORIGIN}/a`, title: "A", initial: true },
      { url: `${ORIGIN}/b`, title: "B", initial: false },
    ]);
  });
});

describe("full loads instead of a swap", () => {
  const start404 = async (pages: StaticDocumentOptions["pages"]) =>
    start({ title: "A", body: nav('<a href="/b">b</a>') }, { pages });

  test.each([
    ["another layout", { identity: "site/Other|b1|" }],
    ["another build", { identity: "site/Layout|b2|" }],
    ["another version", { identity: "site/Layout|b1|pub-2" }],
    ["another stylesheet", { stylesheet: "body{margin:1px}" }],
  ])("when the next page has %s", async (_, change) => {
    const doc = await start404({ "/b": await page({ title: "B", body: "<h1>B</h1>", ...change }) });

    expect(await doc.navigate("/b")).toEqual({ kind: "full-load", url: `${ORIGIN}/b` });
    expect(document.title).toBe("A");
    expect(location.pathname).toBe("/a");
  });

  test("when the next page is not a navigable static page (a hydrated page)", async () => {
    const doc = await start404({ "/b": "<!DOCTYPE html><html><head><title>App</title></head><body>app</body></html>" });
    expect((await doc.navigate("/b")).kind).toBe("full-load");
  });

  test.each([
    ["a 404", { status: 404, html: "<p>missing</p>" }],
    ["a 500", { status: 500, html: "<p>error</p>" }],
    ["not HTML", { contentType: "application/json", html: "{}" }],
    ["a redirect to another origin", { url: "https://elsewhere.dev/b", html: "<p>x</p>" }],
  ])("when the response is %s", async (_, response) => {
    const doc = await start404({ "/b": response });
    expect(await doc.navigate("/b")).toEqual({ kind: "full-load", url: `${ORIGIN}/b` });
  });

  test("when the fetch fails", async () => {
    const doc = await start404(() => Promise.reject(new TypeError("offline")));
    expect(await doc.navigate("/b")).toEqual({ kind: "full-load", url: `${ORIGIN}/b` });
  });
});

describe("islands across a navigation", () => {
  test("the old ones unmount (their effects clean up) and the new ones hydrate", async () => {
    const error = vi.spyOn(console, "error");
    const doc = await start(
      {
        title: "A",
        body: createElement(
          "main",
          null,
          createElement("a", { href: "/b" }, "b"),
          createElement(ScrollLock, { label: "menu-a" }),
          createElement(Counter, { start: 1, label: "A" }),
        ),
      },
      {
        pages: {
          "/b": await page({
            title: "B",
            body: createElement("main", null, createElement(Counter, { start: 10, label: "B" })),
          }),
        },
      },
    );
    await settle();
    expect(document.documentElement.dataset.locked).toBe("menu-a");
    await act(() => document.querySelector("button")!.click());
    expect(document.querySelector("output")!.textContent).toBe("2");

    await act(() => doc.navigate("/b"));
    await settle();

    expect(document.documentElement.dataset.locked).toBeUndefined();
    expect(document.querySelector("label")!.textContent).toBe("B");
    await act(() => document.querySelector("button")!.click());
    expect(document.querySelector("output")!.textContent).toBe("11");
    expect(error).not.toHaveBeenCalled();
  });

  test("an island in a persisted element stays mounted and keeps its state", async () => {
    const body = (label: string) =>
      createElement(
        "div",
        null,
        createElement("a", { href: label === "A" ? "/b" : "/a" }, "next"),
        createElement(
          "header",
          { "data-gemi-persist": "header" },
          createElement(Counter, { start: 0, label: "header" }),
        ),
        createElement("main", null, createElement(ScrollLock, { label }), createElement("h1", null, label)),
      );
    const doc = await start(
      { title: "A", body: body("A") },
      { pages: { "/b": await page({ title: "B", body: body("B") }) } },
    );
    await settle();
    const button = document.querySelector("header button")!;
    await act(() => (button as HTMLElement).click());

    await act(() => doc.navigate("/b"));
    await settle();

    expect(document.querySelector("header button")).toBe(button);
    await act(() => (button as HTMLElement).click());
    expect(document.querySelector("header output")!.textContent).toBe("2");
    expect(document.documentElement.dataset.locked).toBe("B");
  });
});

test("a newer click wins over one still loading", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const b = await page({ title: "B", body: "<h1>B</h1>" });
  const c = await page({ title: "C", body: "<h1>C</h1>" });
  const doc = await start(
    { title: "A", body: nav('<a href="/b">b</a><a href="/c">c</a>') },
    { pages: async (url) => (url.pathname === "/b" ? slow.then(() => b) : c) },
  );

  document
    .querySelector('a[href="/b"]')!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(await doc.navigate("/c")).toEqual({ kind: "swap", url: `${ORIGIN}/c` });
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(document.title).toBe("C");
  expect(location.pathname).toBe("/c");
});

describe("history", () => {
  const two = async () =>
    start(
      { title: "A", body: nav('<a href="/b">b</a>') + "<h1>A</h1>" },
      {
        pages: {
          "/a": await page({ title: "A", body: nav('<a href="/b">b</a>') + "<h1>A</h1>" }),
          "/b": await page({ title: "B", body: "<h1>B</h1>" }),
        },
      },
    );

  test("back and forward swap the entries' pages, from the cache while fresh", async () => {
    const doc = await two();
    await doc.navigate("/b");

    expect(await doc.back()).toEqual({ kind: "swap", url: `${ORIGIN}/a` });
    expect(document.title).toBe("A");

    const forward = new Promise((resolve) =>
      document.addEventListener("gemi:page-load", resolve, { once: true }),
    );
    history.forward();
    await forward;
    expect(document.title).toBe("B");
    // `/b` was fetched once; `/a`, the first page, once when going back.
    expect(doc.requests).toEqual([`${ORIGIN}/b`, `${ORIGIN}/a`]);
  });

  test("going back cancels a navigation still loading", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const a = await page({ title: "A", body: nav('<a href="/b">b</a>') });
    const b = await page({ title: "B", body: nav('<a href="/c">c</a>') });
    const c = await page({ title: "C", body: "<h1>C</h1>" });
    const doc = await start(
      { title: "A", body: nav('<a href="/b">b</a>') },
      {
        pages: async (url) =>
          url.pathname === "/c" ? slow.then(() => c) : url.pathname === "/b" ? b : a,
      },
    );
    await doc.navigate("/b");
    document
      .querySelector('a[href="/c"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(await doc.back()).toEqual({ kind: "swap", url: `${ORIGIN}/a` });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(document.title).toBe("A");
    expect(location.pathname).toBe("/a");
  });

  test("restores the scroll position of the entry it goes back to", async () => {
    const doc = await two();
    const scrollTo = vi.spyOn(window, "scrollTo");
    Object.defineProperty(window, "scrollY", { value: 420, configurable: true });
    await doc.navigate("/b");
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: "instant" });

    await doc.back();
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 420, behavior: "instant" });
    expect(history.scrollRestoration).toBe("manual");
  });

  test("an entry the runtime did not make is loaded in full", async () => {
    const doc = await two();
    history.pushState(null, "", "/foreign");
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      history.back();
    });
    // Back on `/a`, the page shown: nothing to fetch.
    expect(doc.fullLoads).toEqual([]);

    const forward = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    history.forward();
    await forward;
    expect(doc.fullLoads).toEqual([`${ORIGIN}/foreign`]);
    expect(doc.requests).toEqual([]);
  });
});

describe("prefetch", () => {
  const links = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("");
  const pages = async () =>
    Object.fromEntries(
      await Promise.all(
        Array.from({ length: 12 }, async (_, i) => [`/p${i}`, await page({ title: `P${i}`, body: links })]),
      ),
    );
  const hover = (href: string) =>
    document.querySelector(`a[href="${href}"]`)!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("on hover after 65 ms, and the click then uses it", async () => {
    const doc = await start({ title: "A", body: links }, { pages: await pages() });

    hover("/p1");
    await wait(30);
    expect(doc.requests).toEqual([]);
    await wait(60);
    expect(doc.requests).toEqual([`${ORIGIN}/p1`]);

    expect((await doc.navigate("/p1")).kind).toBe("swap");
    expect(doc.requests).toEqual([`${ORIGIN}/p1`]);
  });

  test("a hover that leaves before 65 ms fetches nothing", async () => {
    const doc = await start({ title: "A", body: links }, { pages: await pages() });
    hover("/p1");
    document.querySelector('a[href="/p1"]')!.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    await wait(90);
    expect(doc.requests).toEqual([]);
  });

  test("on focus and touchstart right away", async () => {
    const doc = await start({ title: "A", body: links }, { pages: await pages() });
    (document.querySelector('a[href="/p2"]') as HTMLElement).focus();
    document.querySelector('a[href="/p3"]')!.dispatchEvent(new Event("touchstart", { bubbles: true }));
    expect(doc.requests).toEqual([`${ORIGIN}/p2`, `${ORIGIN}/p3`]);
  });

  test("keeps 10 pages, dropping the least recently used", async () => {
    const doc = await start({ title: "A", body: links }, { pages: await pages() });
    for (let i = 0; i < 11; i++) {
      (document.querySelector(`a[href="/p${i}"]`) as HTMLElement).focus();
    }
    expect(doc.requests).toHaveLength(11);

    await doc.navigate("/p0");
    expect(doc.requests.at(-1)).toBe(`${ORIGIN}/p0`);
    expect(doc.requests).toHaveLength(12);
  });

  test("a cached page older than 30 s is fetched again", async () => {
    const doc = await start({ title: "A", body: links }, { pages: await pages() });
    const now = Date.now();
    (document.querySelector('a[href="/p1"]') as HTMLElement).focus();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);

    await doc.navigate("/p1");
    expect(doc.requests).toEqual([`${ORIGIN}/p1`, `${ORIGIN}/p1`]);
  });

  test("is off with prefetch: \"none\"", async () => {
    const html = (await page({ title: "A", body: links })).replace(
      '<meta name="gemi-static"',
      '<meta data-prefetch="none" name="gemi-static"',
    );
    handle = renderStaticDocument(html, { url: "/a", pages: await pages() });
    (document.querySelector('a[href="/p2"]') as HTMLElement).focus();
    expect(handle.requests).toEqual([]);
  });
});
