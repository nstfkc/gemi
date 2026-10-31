// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, expect, test } from "vitest";

import { createStaticRenderCollector, island, StaticRenderContext } from "../client/islands";
import * as CounterModule from "../services/router/__fixtures__/islands/Counter";
import { spliceIslandSlots } from "../services/router/staticDocument";
import { renderStaticDocument, type StaticDocumentHandle } from "./staticDocument";

/**
 * `renderStaticDocument` under happy-dom (#1102), as in an app whose tests
 * preload `@happy-dom/global-registrator`: the jsdom tests are in
 * `services/router/staticNavigation.browser.test.tsx`.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const Counter = island(
  Object.assign(() => Promise.resolve(CounterModule), {
    gemiIsland: "Counter",
    gemiModule: CounterModule,
  }) as () => Promise<any>,
) as (props: { start: number; label: string }) => ReactElement;

async function page(title: string, body: string | ReactElement): Promise<string> {
  let markup = body;
  let table = "";
  if (typeof markup !== "string") {
    const collector = createStaticRenderCollector(async (element, identifierPrefix) => {
      const stream = await renderToReadableStream(element, { identifierPrefix });
      await stream.allReady;
      return await new Response(stream).text();
    });
    const stream = await renderToReadableStream(
      createElement(StaticRenderContext.Provider, { value: collector }, markup),
    );
    await stream.allReady;
    markup = spliceIslandSlots(await new Response(stream).text());
    const entries = collector.islands.map((entry) => ({
      s: `/assets/${entry.module}.js`,
      e: entry.export,
      l: entry.load,
    }));
    table = `<script type="application/json" id="gemi-islands">${JSON.stringify({ i: entries })}</script>`;
  }
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="gemi-static" content="site/Layout|b1|"></head>` +
    `<body>${markup}${table}<script type="module">/* the runtime */</script></body></html>`
  );
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

let handle: StaticDocumentHandle | undefined;
afterEach(() => {
  handle?.dispose();
  handle = undefined;
});

test("renders the document, hydrates an island and swaps a page in under happy-dom", async () => {
  const first = await page(
    "A",
    createElement(
      "main",
      null,
      createElement("a", { href: "/b" }, "b"),
      createElement(Counter, { start: 1, label: "Count" }),
    ),
  );
  const second = await page("B", "<main><h1>B</h1></main>");

  handle = renderStaticDocument(first, {
    url: "/a",
    islands: { "/assets/Counter.js": CounterModule },
    pages: { "/b": second },
  });
  expect(document.title).toBe("A");
  expect(document.documentElement.getAttribute("lang")).toBe("en");
  expect(document.querySelectorAll("html")).toHaveLength(1);
  await settle();

  // Hydrated: the island's button works on the server's node.
  const output = document.querySelector("output")!;
  expect(output.textContent).toBe("1");
  await act(() => document.querySelector<HTMLButtonElement>(".counter button")!.click());
  expect(document.querySelector("output")).toBe(output);
  expect(output.textContent).toBe("2");

  const result = await handle.navigate("/b");
  expect(result.kind).toBe("swap");
  expect(document.title).toBe("B");
  expect(document.querySelector("h1")!.textContent).toBe("B");
});
