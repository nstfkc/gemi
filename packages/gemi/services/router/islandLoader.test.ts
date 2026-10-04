// @vitest-environment jsdom
import { join } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createStaticRenderCollector, island, StaticRenderContext } from "../../client/islands";
import { ISLAND_HYDRATE_SOURCE } from "../../internal/islandRuntime";
import * as CounterModule from "./__fixtures__/islands/Counter";
import { ISLAND_LOADER_SOURCE, spliceIslandSlots } from "./staticDocument";

/**
 * Islands as the browser runs them: markup rendered the way a static view
 * renders it, the constant loader, and the runtime's `h` against real React.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const brokenSrc = join(import.meta.dirname, "__fixtures__/islands/broken.mjs");
const COUNTER = "entry:counter";

/** The island runtime (`virtual:gemi-island-runtime`) with real React. */
const runtime = new Function(
  "createElement",
  "hydrateRoot",
  `${ISLAND_HYDRATE_SOURCE};return { h };`,
)(createElement, hydrateRoot) as { h: (marker: Element, component: unknown) => unknown };

/** What gemi's Vite plugin turns the loader into. */
const tagged = (key: string, mod: Record<string, unknown>) =>
  Object.assign(() => Promise.resolve(mod), { gemiIsland: key, gemiModule: mod }) as () => Promise<
    typeof CounterModule
  >;

const Counter = island(tagged(COUNTER, CounterModule));
const LazyCounter = island(tagged(COUNTER, CounterModule), { load: "visible" });
const IdleGreeting = island(tagged(COUNTER, CounterModule), { export: "Greeting", load: "idle" });
const Broken = island(
  tagged("broken", { default: () => createElement("a", { href: "/x" }, "x") }) as any,
) as () => ReactElement;

const sources: Record<string, string> = { [COUNTER]: COUNTER, broken: brokenSrc };

/**
 * Renders `page` the way a static view does (each island its own root) and
 * puts it in the document with the island table the server would add.
 */
async function serve(page: ReactElement) {
  const collector = createStaticRenderCollector(async (element, identifierPrefix) => {
    const stream = await renderToReadableStream(element, { identifierPrefix });
    await stream.allReady;
    return await new Response(stream).text();
  });
  const stream = await renderToReadableStream(
    createElement(StaticRenderContext.Provider, { value: collector }, page),
  );
  await stream.allReady;
  const html = spliceIslandSlots(await new Response(stream).text());
  const table = {
    i: collector.islands.map((entry) => ({ s: sources[entry.module!], e: entry.export, l: entry.load })),
  };
  document.body.innerHTML =
    html + `<script type="application/json" id="gemi-islands">${JSON.stringify(table)}</script>`;
}

/**
 * Runs the loader. Code built with `new Function` has no module context to
 * resolve a bare `import()` against, so `import` is handed in; everything else
 * is the source exactly as shipped.
 */
function runLoader() {
  expect(ISLAND_LOADER_SOURCE.match(/import\(/g)).toHaveLength(1);
  new Function("__import", ISLAND_LOADER_SOURCE.replace("import(", "__import("))(
    // What `Counter.tsx?gemi-island` exports: the module as `m`, and `h`.
    (specifier: string) =>
      specifier === COUNTER
        ? Promise.resolve({ m: CounterModule, h: runtime.h })
        : import(/* @vite-ignore */ specifier),
  );
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

const outputs = () => Array.from(document.querySelectorAll("output")).map((o) => o.textContent);

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("islands in the browser", () => {
  test("hydrate the component in place: same DOM, live state, no mismatch", async () => {
    const error = vi.spyOn(console, "error");
    await serve(
      createElement(
        "main",
        null,
        createElement(Counter, { start: 1, label: "First" }),
        createElement(Counter, { start: 10, label: "Second" }),
      ),
    );
    const button = document.querySelector("button")!;
    runLoader();
    await settle();

    // Hydration adopted the server's nodes rather than replacing them.
    expect(document.querySelector("button")).toBe(button);
    await act(() => button.click());
    expect(outputs()).toEqual(["2", "10"]);
    // A hydration mismatch (a different `useId`, different props) is
    // reported through console.error.
    expect(error).not.toHaveBeenCalled();
  });

  test("keep each island's ids apart and matching the server's", async () => {
    const error = vi.spyOn(console, "error");
    await serve(
      createElement(
        "main",
        null,
        createElement(Counter, { start: 1, label: "A" }),
        createElement(Counter, { start: 1, label: "B" }),
      ),
    );
    runLoader();
    await settle();

    const ids = Array.from(document.querySelectorAll("output")).map((o) => o.id);
    expect(new Set(ids).size).toBe(2);
    for (const label of document.querySelectorAll("label")) {
      expect(document.getElementById(label.htmlFor)).not.toBeNull();
    }
    expect(error).not.toHaveBeenCalled();
  });

  test("pass static children through untouched", async () => {
    const error = vi.spyOn(console, "error");
    await serve(
      createElement(
        Counter,
        { start: 0, label: "With children" },
        createElement("p", { className: "static" }, "Server-rendered ", createElement("em", null, "child")),
      ),
    );
    const child = document.querySelector("p.static")!;
    runLoader();
    await settle();

    await act(() => document.querySelector("button")!.click());
    expect(outputs()).toEqual(["1"]);
    expect(document.querySelector("p.static")).toBe(child);
    expect(child.innerHTML).toBe("Server-rendered <em>child</em>");
    expect(error).not.toHaveBeenCalled();
  });

  test("hydrate an island in another's children on its own", async () => {
    const error = vi.spyOn(console, "error");
    await serve(
      createElement(
        Counter,
        { start: 0, label: "Outer" },
        createElement(Counter, { start: 5, label: "Inner" }),
      ),
    );
    runLoader();
    await settle();

    const [outer, inner] = document.querySelectorAll("button");
    await act(() => inner.click());
    await act(() => outer.click());
    expect(outputs()).toEqual(["1", "6"]);
    expect(error).not.toHaveBeenCalled();
  });

  test("wait for idle time on an idle island, and use the named export", async () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => callbacks.push(fn));
    const h = vi.spyOn(runtime, "h");
    await serve(createElement(IdleGreeting, { name: "Ada" }));
    runLoader();
    await settle();
    expect(h).not.toHaveBeenCalled();

    callbacks.forEach((fn) => fn());
    await settle();
    expect(h).toHaveBeenCalledOnce();
    expect(h.mock.calls[0][1]).toBe(CounterModule.Greeting);
    expect(document.body.textContent).toContain("Hello, Ada");
  });

  test("wait for a visible island's content to scroll into view", async () => {
    const observers: { cb: (entries: { isIntersecting: boolean }[]) => void; targets: Element[] }[] =
      [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        targets: Element[] = [];
        constructor(public cb: (entries: { isIntersecting: boolean }[]) => void) {
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        disconnect() {}
      },
    );
    await serve(createElement(LazyCounter, { start: 3, label: "Lazy" }));
    runLoader();
    await settle();

    // The marker is `display: contents` and has no box: its children are
    // what gets observed.
    expect(observers[0].targets[0].className).toBe("counter");
    await act(() => document.querySelector("button")!.click());
    expect(outputs()).toEqual(["3"]);

    observers[0].cb([{ isIntersecting: true }]);
    await settle();
    await act(() => document.querySelector("button")!.click());
    expect(outputs()).toEqual(["4"]);
  });

  test("log a module that fails and keep the server-rendered markup", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await serve(createElement(Broken));
    runLoader();
    await settle();

    expect(error).toHaveBeenCalled();
    expect(document.querySelector("gemi-island")!.innerHTML).toBe('<a href="/x">x</a>');
  });

  test("leave markers alone that the table does not name", async () => {
    const h = vi.spyOn(runtime, "h");
    document.body.innerHTML =
      `<gemi-island data-island="7"><p>x</p></gemi-island>` +
      `<script type="application/json" id="gemi-islands">{"i":[]}</script>`;
    runLoader();
    await settle();

    expect(h).not.toHaveBeenCalled();
  });
});
