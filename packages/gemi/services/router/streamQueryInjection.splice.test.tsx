/** @vitest-environment node */
import { describe, expect, test } from "vitest";
import { JSDOM } from "jsdom";
import { Suspense } from "react";
// @ts-ignore — same untyped entry the view router renders with.
import { renderToReadableStream } from "react-dom/server.browser";

import { ServerQueryStore, type ServerQueryFetcher } from "./ServerQueryStore";
import { injectQueryPayloads } from "./streamQueryInjection";

/**
 * Regression tests for #404: the injector used to flush its queue at React's
 * chunk boundaries, which are 2048-byte view boundaries and not markup
 * boundaries, splicing `<script>` into the middle of a tag or a raw-text
 * element. In production that produced
 *
 *   <link rel="modulepre<script>(self.__GEMI_STREAM__=…)…</script>load" href="…"/>
 *
 * — payload swallowed as attributes, tail leaked as text, modulepreload lost.
 */

function createSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    write: (html: string) => controller.enqueue(encoder.encode(html)),
    close: () => controller.close(),
  };
}

function createDeferredFetcher() {
  const calls: Array<{ resolve: (data: any) => void }> = [];
  const fetcher: ServerQueryFetcher = () =>
    new Promise((resolve) => {
      calls.push({ resolve });
    });
  return { fetcher, calls };
}

/** A store holding one resolved entry, as a settled document's backlog would. */
async function storeWithSettledEntry(path: string, data: unknown) {
  const { fetcher, calls } = createDeferredFetcher();
  const store = new ServerQueryStore(fetcher);
  const entry = store.ensure(path);
  calls[0]!.resolve(data);
  await entry.promise;
  return store;
}

const PAYLOAD_RE = /<script>\(self\.__GEMI_STREAM__=[\s\S]*?<\/script>/g;

describe("payload splicing (#404)", () => {
  test("a payload queued at a mid-tag boundary lands after that tag", async () => {
    const store = await storeWithSettledEntry("/public/prices", [{ price: 2999 }]);
    const source = createSource();
    const html = new Response(
      injectQueryPayloads(source.stream, store),
    ).text();

    // Byte-identical to what React did on folioai.com/pricing: the view filled
    // up in the middle of a `<link>`, and the queue was non-empty.
    source.write('<!doctype html><html><head><link rel="modulepre');
    source.write('load" href="/assets/dist.js"/><link rel="modulepreload" href="/b.js"/>');
    source.write("</head><body><p>hi</p></body></html>");
    source.close();

    const text = await html;
    expect(text).toContain(
      '<link rel="modulepreload" href="/assets/dist.js"/>',
    );
    expect(text).not.toContain("<link rel=\"modulepre<script>");

    const { document } = new JSDOM(text).window;
    // The payload survived as a real script element rather than as attributes.
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.textContent).toContain('"/public/prices"');
    // Both preloads survived, and nothing leaked into the body as text.
    expect(document.querySelectorAll("link")).toHaveLength(2);
    expect(document.body.textContent).toBe("hi");
  });

  test.each([
    ["a style body", "<style>.a{color:", "red}</style><p>x</p>"],
    ["a comment", "<!-- keep", " going --><p>x</p>"],
    ["a script body", "<script>var a=1", ";</script><p>x</p>"],
    ["a title", "<title>Pri", "cing</title><p>x</p>"],
  ])("a payload is never spliced into %s", async (_label, head, tail) => {
    const store = await storeWithSettledEntry("/q", { ok: true });
    const source = createSource();
    const html = new Response(
      injectQueryPayloads(source.stream, store),
    ).text();

    source.write(`<!doctype html><html><head>${head}`);
    source.write(`${tail}</head><body></body></html>`);
    source.close();

    const text = await html;
    const matches = text.match(PAYLOAD_RE);
    expect(matches).toHaveLength(1);
    // The element is intact and the payload sits after it, not inside it.
    const element = `${head}${tail}`.slice(0, `${head}${tail}`.indexOf("<p>"));
    expect(text).toContain(element);
    expect(text.indexOf(matches![0]!)).toBeGreaterThan(
      text.indexOf(element) + element.length - 1,
    );
  });

  test("a payload with no safe offset waits rather than corrupting the chunk", async () => {
    const store = await storeWithSettledEntry("/q", { ok: true });
    const source = createSource();
    const html = new Response(
      injectQueryPayloads(source.stream, store),
    ).text();

    source.write("<!doctype html><html><head><style>");
    // A whole chunk with nowhere legal to splice.
    source.write(".a{color:red}".repeat(40));
    source.write("</style></head><body></body></html>");
    source.close();

    const text = await html;
    expect(text.match(PAYLOAD_RE)).toHaveLength(1);
    expect(text).toContain(`<style>${".a{color:red}".repeat(40)}</style>`);
  });

  test("a real React render keeps every injected payload parseable", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    store.markRenderStart();

    // Enough head markup to span many of React's 2048-byte views, with varying
    // tag lengths so boundaries land inside tags rather than between them.
    const links = Array.from({ length: 60 }, (_, i) => (
      <link
        key={i}
        rel="modulepreload"
        href={`/assets/chunk-${"x".repeat((i % 7) + 1)}-${i}.js`}
      />
    ));

    function Prices() {
      // Suspends the render until the entry settles, so the payload is queued
      // mid-stream — the streaming half of the bug.
      const entry = store.ensure("/public/prices");
      if (entry.status === "pending") throw entry.promise;
      return <p>loaded</p>;
    }

    const element = (
      <html lang="en">
        <head>
          {links}
          <title>Pricing</title>
          <style>{".a{color:red}"}</style>
        </head>
        <body>
          <main>
            <Suspense fallback={<div>skeleton</div>}>
              <Prices />
            </Suspense>
          </main>
        </body>
      </html>
    );

    const stream: ReadableStream<Uint8Array> & { allReady: Promise<void> } =
      await renderToReadableStream(element, { onError: () => {} });
    const body = new Response(injectQueryPayloads(stream, store)).text();
    calls[0]!.resolve([{ key: "basic", price: 2999 }]);

    const text = await body;
    const payloads = text.match(PAYLOAD_RE) ?? [];
    expect(payloads).toHaveLength(1);

    const { document } = new JSDOM(text).window;
    const injected = [...document.querySelectorAll("script")].filter((s) =>
      s.textContent?.includes("__GEMI_STREAM__"),
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]!.textContent).toContain('"/public/prices"');
    // Every preload made it through as an element, none mangled into text.
    expect(document.querySelectorAll("link[rel=modulepreload]")).toHaveLength(60);
    expect(document.querySelector("title")?.textContent).toBe("Pricing");
    expect(document.querySelector("style")?.textContent).toBe(".a{color:red}");
    expect(document.body.textContent).not.toContain("modulepreload");
  });
});
