/** @vitest-environment node */
import { Suspense } from "react";
// @ts-ignore — same untyped entry the view router renders with.
import { renderToReadableStream } from "react-dom/server.browser";
import { afterEach, describe, expect, test } from "vitest";

import { defineDictionary, __gemi_dict__ } from "../i18n/defineDictionary";
import { __resetDictionaryRegistry } from "../i18n/dictionaryRegistry";
import { createDictionarySink } from "../i18n/dictionarySink";
import { dictionaryId, localeStrings } from "../i18n/dictionaryShape";
import { ServerQueryStore } from "../services/router/ServerQueryStore";
import { injectQueryPayloads } from "../services/router/streamQueryInjection";
import { DictionarySinkContext } from "./DictionarySinkContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useDictionary } from "./useDictionary";

const TRANSLATIONS = {
  greeting: { "en-US": "Hello {{name}}", "tr-TR": "Merhaba {{name}}" },
  cta: { "en-US": "Get started", "tr-TR": "Başla" },
} as const;

afterEach(() => {
  __resetDictionaryRegistry();
});

function App(props: {
  locale: string;
  sink?: ReturnType<typeof createDictionarySink> | null;
  children: React.ReactNode;
}) {
  return (
    <DictionarySinkContext.Provider value={props.sink ?? null}>
      <RouteStateProvider
        state={
          { i18n: { currentLocale: props.locale } } as unknown as RouteState &
            PageData
        }
      >
        {/* React streams no fallback for a boundary with no host content
            above it — real pages always have the root layout here. */}
        <main>
          <Suspense fallback={<div>skeleton</div>}>{props.children}</Suspense>
        </main>
      </RouteStateProvider>
    </DictionarySinkContext.Provider>
  );
}

async function render(element: React.ReactNode, sink?: any) {
  const store = new ServerQueryStore({ fetcher: async () => ({}) } as any);
  store.markRenderStart?.();
  const stream: ReadableStream<Uint8Array> & { allReady: Promise<void> } =
    await renderToReadableStream(element, { onError: () => {} });
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = injectQueryPayloads(stream, store, {}, sink).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  return chunks.join("");
}

describe("an unbundled dictionary", () => {
  test("renders the requested locale and interpolates", async () => {
    const dict = defineDictionary(TRANSLATIONS);
    const View = () => {
      const t = useDictionary(dict);
      return (
        <p>
          {t("greeting", { name: "Enes" })} — {t("cta")}
        </p>
      );
    };

    const html = await render(
      <App locale="tr-TR">
        <View />
      </App>,
    );
    expect(html).toContain("Merhaba Enes");
    expect(html).toContain("Başla");
  });

  test("never suspends — the strings are already in memory", async () => {
    // The whole point of keeping the untransformed path synchronous: tests and
    // server code that skip the bundler must not need a Suspense boundary.
    const dict = defineDictionary(TRANSLATIONS);
    const View = () => <p>{useDictionary(dict)("cta")}</p>;

    const html = await render(
      <App locale="en-US">
        <View />
      </App>,
    );
    expect(html).toContain("Get started");
    expect(html).not.toContain("skeleton");
  });

  test("falls back to the source language for an untranslated key", async () => {
    const dict = defineDictionary({
      done: { "en-US": "Done", "tr-TR": "Bitti" },
      pending: { "en-US": "Pending" },
    });
    const View = () => {
      const t = useDictionary(dict);
      return <p>{t("pending")}</p>;
    };

    const html = await render(
      <App locale="tr-TR">
        <View />
      </App>,
    );
    expect(html).toContain("Pending");
  });
});

describe("a bundled dictionary", () => {
  /** What the Vite plugin's rewritten call site produces. */
  function bundled(delayMs = 0) {
    const locales = ["en-US", "tr-TR"];
    const loaders = Object.fromEntries(
      locales.map((locale) => [
        locale,
        () =>
          new Promise<{ default: Record<string, string> }>((resolve) =>
            setTimeout(
              () => resolve({ default: localeStrings(TRANSLATIONS, locale) }),
              delayMs,
            ),
          ),
      ]),
    );
    return __gemi_dict__(dictionaryId(TRANSLATIONS), loaders);
  }

  test("suspends on the locale's chunk, then renders it", async () => {
    const dict = bundled(10);
    const View = () => <p>{useDictionary(dict)("cta")}</p>;

    const html = await render(
      <App locale="tr-TR">
        <View />
      </App>,
    );
    expect(html).toContain("skeleton");
    expect(html).toContain("Başla");
    // Only the locale asked for is ever fetched.
    expect(html).not.toContain("Get started");
  });

  test("shares one load between components reading the same dictionary", async () => {
    let loads = 0;
    const dict = __gemi_dict__(dictionaryId(TRANSLATIONS), {
      "en-US": async () => {
        loads++;
        return { default: localeStrings(TRANSLATIONS, "en-US") };
      },
    });
    const View = () => <span>{useDictionary(dict)("cta")}</span>;

    await render(
      <App locale="en-US">
        <View />
        <View />
        <View />
      </App>,
    );
    expect(loads).toBe(1);
  });

  test("carries the id its unbundled twin would compute", async () => {
    // The client registry finds streamed strings by id, so the id has to be a
    // property of the literal, not of how it was built.
    expect(bundled().id).toBe(defineDictionary(TRANSLATIONS).id);
  });
});

/** The `__GEMI_DICT__` payload scripts in a rendered document, in order. */
function dictionaryScripts(html: string): string[] {
  return Array.from(
    html.matchAll(/<script>\(self\.__GEMI_DICT__=.*?<\/script>/g),
    (m) => m[0],
  );
}

describe("the hydration payload", () => {
  test("streams the strings the render used, and no other locale", async () => {
    const dict = defineDictionary(TRANSLATIONS);
    const sink = createDictionarySink();
    const View = () => <p>{useDictionary(dict)("cta")}</p>;

    const html = await render(
      <App locale="tr-TR" sink={sink}>
        <View />
      </App>,
      sink,
    );

    const payload = dictionaryScripts(html);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toContain(dict.id);
    // Turkish only, in the payload as well as the markup — shipping the English
    // alongside is exactly the waste this replaces.
    expect(payload[0]).toContain("Başla");
    expect(payload[0]).not.toContain("Get started");
    expect(html).not.toContain("Get started");
  });

  test("emits one script per dictionary however many components read it", async () => {
    const dict = defineDictionary(TRANSLATIONS);
    const sink = createDictionarySink();
    const View = () => <span>{useDictionary(dict)("cta")}</span>;

    const html = await render(
      <App locale="en-US" sink={sink}>
        <View />
        <View />
      </App>,
      sink,
    );

    expect(dictionaryScripts(html)).toHaveLength(1);
  });

  test("a dictionary revealed late still lands ahead of its own segment", async () => {
    // The ordering the design depends on: hydration must never meet a revealed
    // segment whose strings are not yet in the registry.
    const dict = __gemi_dict__(dictionaryId(TRANSLATIONS), {
      "en-US": () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ default: localeStrings(TRANSLATIONS, "en-US") }),
            10,
          ),
        ),
    });
    const sink = createDictionarySink();
    const View = () => <p id="late">{useDictionary(dict)("cta")}</p>;

    const html = await render(
      <App locale="en-US" sink={sink}>
        <View />
      </App>,
      sink,
    );

    const payloadAt = html.indexOf("__GEMI_DICT__");
    const revealAt = html.indexOf("Get started");
    expect(payloadAt).toBeGreaterThan(-1);
    expect(revealAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeLessThan(revealAt);
  });

  test("no sink, no scripts — the browser does not collect", async () => {
    const dict = defineDictionary(TRANSLATIONS);
    const View = () => <p>{useDictionary(dict)("cta")}</p>;

    const html = await render(
      <App locale="en-US">
        <View />
      </App>,
    );
    expect(html).not.toContain("__GEMI_DICT__");
  });
});
