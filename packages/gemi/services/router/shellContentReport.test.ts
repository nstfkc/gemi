/** @vitest-environment node */
import { describe, expect, test } from "vitest";
import { createElement, Suspense } from "react";
// @ts-ignore — same untyped entry the view router renders with.
import { renderToReadableStream } from "react-dom/server.browser";

import {
  createShellContentObserver,
  DEFERRED_TEXT_FLOOR,
  measureShellContent,
  SHELL_TEXT_NEAR_ZERO,
  shellContentHint,
} from "./shellContentReport";
import { injectQueryPayloads } from "./streamQueryInjection";
import { ServerQueryStore } from "./ServerQueryStore";

describe("measureShellContent", () => {
  test("counts readable text, not markup, scripts, styles, titles, or comments", () => {
    const { shellChars, deferredChars } = measureShellContent(
      `<!doctype html><html><head><title>Site title</title>` +
        `<style>.a{color:red}</style>` +
        `<script>window.__GEMI_DATA__ = {"k":"vvvvvv"}</script></head>` +
        `<body><!--$?--><template id="B:0"></template><!--/$-->` +
        `<h1 class="big">Hello</h1> <p data-x="attr text">world</p></body></html>`,
    );
    expect(shellChars).toBe("Hello".length + "world".length);
    expect(deferredChars).toBe(0);
  });

  test("text inside `<div hidden>` reveal segments counts as deferred, nested divs included", () => {
    const { shellChars, deferredChars } = measureShellContent(
      `<main><p>shell text</p></main>` +
        `<div hidden id="S:0"><div><p>deep deferred</p></div><span>more</span></div>` +
        `<script>$RC("B:0","S:0")</script>` +
        `<p>after</p>`,
    );
    expect(shellChars).toBe("shelltext".length + "after".length);
    expect(deferredChars).toBe("deepdeferred".length + "more".length);
  });

  test("`hidden` in an attribute value does not open a deferred segment", () => {
    const { shellChars, deferredChars } = measureShellContent(
      `<div class="hidden">still readable</div>`,
    );
    expect(shellChars).toBe("stillreadable".length);
    expect(deferredChars).toBe(0);
  });

  test("whitespace never counts", () => {
    const { shellChars } = measureShellContent(`<div>\n  a b\t c \n</div>`);
    expect(shellChars).toBe(3);
  });
});

describe("shellContentHint", () => {
  const deferred = (chars: number) => "x".repeat(chars);

  test("the #289 repro flags: 0 shell chars, 3666 deferred", () => {
    const measurement = measureShellContent(
      `<!doctype html><body><!--$?--><template id="B:0"></template><!--/$-->` +
        `<div hidden id="S:0"><p>${deferred(3666)}</p></div></body>`,
    );
    expect(measurement).toEqual({ shellChars: 0, deferredChars: 3666 });

    const hint = shellContentHint("/", measurement);
    expect(hint).toContain("[gemi] GET / streams 3.7 kB");
    expect(hint).toContain("a no-JS visitor sees ~0 chars");
    expect(hint).toContain('add "no-stream" to its middleware');
  });

  test("a page whose shell carries its own text stays silent: 4150 shell, 0 deferred", () => {
    const measurement = measureShellContent(`<body><article>${deferred(4150)}</article></body>`);
    expect(measurement).toEqual({ shellChars: 4150, deferredChars: 0 });
    expect(shellContentHint("/about-us", measurement)).toBeNull();
  });

  test("deferred text under the floor stays silent even with a blank shell", () => {
    expect(
      shellContentHint("/", { shellChars: 0, deferredChars: DEFERRED_TEXT_FLOOR - 1 }),
    ).toBeNull();
    expect(
      shellContentHint("/", { shellChars: 0, deferredChars: DEFERRED_TEXT_FLOOR }),
    ).not.toBeNull();
  });

  test("a shell with readable text stays silent regardless of deferred volume", () => {
    expect(
      shellContentHint("/", { shellChars: SHELL_TEXT_NEAR_ZERO, deferredChars: 50_000 }),
    ).toBeNull();
    expect(
      shellContentHint("/", { shellChars: SHELL_TEXT_NEAR_ZERO - 1, deferredChars: 50_000 }),
    ).not.toBeNull();
  });
});

describe("createShellContentObserver", () => {
  test("decodes multi-byte characters split across chunks", () => {
    const observer = createShellContentObserver();
    const bytes = new TextEncoder().encode("<p>héllo</p>");
    // "é" is two bytes; split right between them.
    const splitAt = 5;
    observer.onChunk(bytes.slice(0, splitAt));
    observer.onChunk(bytes.slice(splitAt));
    expect(observer.measure()).toEqual({ shellChars: 5, deferredChars: 0 });
  });

  test("measures a real suspended render through the injector's onChunk hook", async () => {
    let ready = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate.then(() => {
      ready = true;
    });
    const content = "deferred ".repeat(500).trim(); // ~4.5 kB of readable text
    function Late() {
      if (!ready) throw gate;
      return createElement("p", null, content);
    }

    const stream = await renderToReadableStream(
      createElement(
        "main",
        null,
        createElement(Suspense, { fallback: createElement("div", null, "…") }, createElement(Late)),
      ),
      { onError: () => {} },
    );

    const store = new ServerQueryStore(() => Promise.resolve(null));
    const observer = createShellContentObserver();
    const reader = injectQueryPayloads(stream, store, {
      onChunk: observer.onChunk,
    }).getReader();
    const drained = (async () => {
      while (!(await reader.read()).done) {
        // Drain — the observer sees every chunk as it is enqueued.
      }
    })();

    // Let the shell (with the fallback in place) flush before the segment
    // resolves — that is what parks the content behind a reveal script.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await drained;

    const measurement = observer.measure();
    // The shell carries only the fallback; the content is parked in a
    // `<div hidden id="S:0">` reveal segment.
    expect(measurement.shellChars).toBeLessThan(SHELL_TEXT_NEAR_ZERO);
    expect(measurement.deferredChars).toBe(content.replace(/\s/g, "").length);
    expect(shellContentHint("/", measurement)).toContain("behind reveal scripts");
  });
});
