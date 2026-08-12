/** @vitest-environment node */
import { lazy, Suspense } from "react";
// @ts-ignore — same untyped entry the view router renders with.
import { renderToReadableStream } from "react-dom/server.browser";
import { afterEach, describe, expect, test } from "vitest";

import { defineDictionary, __gemi_dict__ } from "../i18n/defineDictionary";
import {
  __resetDictionaryRegistry,
  dictionaryRegistrationMark,
  preloadDictionaries,
} from "../i18n/dictionaryRegistry";
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

describe("preloading", () => {
  function counted(id: string) {
    const state = { loads: 0 };
    const dict = __gemi_dict__(id, {
      "en-US": async () => {
        state.loads++;
        return { default: { cta: "Get started" } };
      },
    });
    return { dict, state };
  }

  test("a warmed dictionary renders without suspending", async () => {
    const { dict } = counted("d_warm");
    await preloadDictionaries("en-US");

    const View = () => <p>{useDictionary(dict)("cta")}</p>;
    const html = await render(
      <App locale="en-US">
        <View />
      </App>,
    );
    expect(html).toContain("Get started");
    // The reason the server preloads at all: a suspend here would split the
    // segment out of the shell, one reveal chunk per dictionary.
    expect(html).not.toContain("skeleton");
  });

  test("an unmarked preload resumes from where the locale got to", async () => {
    // The server calls this per request with no mark. Rescanning from zero
    // every time would make each request cost O(every dictionary in the app) —
    // the same shape of problem this change exists to remove.
    const first = counted("d_first");
    await preloadDictionaries("en-US");
    expect(first.state.loads).toBe(1);

    const second = counted("d_second");
    await preloadDictionaries("en-US");

    expect(second.state.loads).toBe(1);
    // Already warm, and not revisited.
    expect(first.state.loads).toBe(1);
  });

  test("a mark limits the preload to what registered after it", async () => {
    const before = counted("d_before");
    const mark = dictionaryRegistrationMark();
    const after = counted("d_after");

    await preloadDictionaries("en-US", mark);

    expect(after.state.loads).toBe(1);
    expect(before.state.loads).toBe(0);
  });

  test("a concurrent preload does not skip past loads still in flight", async () => {
    // The watermark used to move before the imports settled, so a second
    // request arriving mid-flight found an empty slice, returned immediately,
    // and then suspended on those same in-flight promises anyway — the stream
    // fragmentation the preload exists to prevent.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let loads = 0;
    const dict = __gemi_dict__("d_concurrent", {
      "en-US": async () => {
        loads++;
        await gate;
        return { default: { cta: "Get started" } };
      },
    });

    const first = preloadDictionaries("en-US");
    const second = preloadDictionaries("en-US");

    release();
    await Promise.all([first, second]);

    // Both callers waited for the same single load.
    expect(loads).toBe(1);
    // And it really is resolved for whoever renders next.
    const View = () => <p>{useDictionary(dict)("cta")}</p>;
    const html = await render(
      <App locale="en-US">
        <View />
      </App>,
    );
    expect(html).not.toContain("skeleton");
  });

  test("a failed load stays below the watermark and is retried", async () => {
    // The doc comment promises exactly this, and advancing the watermark over a
    // swallowed failure would have made it a lie: the dictionary would never be
    // reloaded by a later preload.
    let fail = true;
    let attempts = 0;
    __gemi_dict__("d_retry", {
      "en-US": () => {
        attempts++;
        return fail
          ? Promise.reject(new Error("gone"))
          : Promise.resolve({ default: { cta: "Get started" } });
      },
    });

    await preloadDictionaries("en-US");
    expect(attempts).toBe(1);

    fail = false;
    await preloadDictionaries("en-US");
    expect(attempts).toBe(2);
  });

  test("each locale keeps its own watermark", async () => {
    const { dict, state } = counted("d_perlocale");
    // Same dictionary, two locales — warming one must not mark the other done.
    await preloadDictionaries("en-US");
    expect(state.loads).toBe(1);

    await preloadDictionaries("tr-TR");
    // Falls back to the only loader it has, but it does get asked.
    expect(state.loads).toBe(2);
    expect(dict.id).toBe("d_perlocale");
  });
});

describe("a dictionary that fails to load", () => {
  /**
   * A locale chunk going missing is routine — a browser holding stale HTML
   * after a rolling deploy asks for a hashed filename that no longer exists.
   * The deprecated `useTranslator` degraded any i18n failure to rendering the
   * key; letting a rejection out of `use()` instead would unmount the route
   * into its error boundary, or fail the server render outright.
   */
  test("renders keys instead of taking the render down", async () => {
    const dict = __gemi_dict__(dictionaryId(TRANSLATIONS), {
      "en-US": () => Promise.reject(new Error("Failed to fetch dynamically imported module")),
    });
    const View = () => <p>{useDictionary(dict)("cta")}</p>;

    const html = await render(
      <App locale="en-US">
        <View />
      </App>,
    );

    expect(html).toContain("cta");
    expect(html).not.toContain("Failed to fetch");
  });

  test("stays degraded across re-renders rather than suspending forever", async () => {
    // `use()` needs a stable promise. Rebuilding the degraded one per render
    // would suspend on a fresh promise every pass and never settle.
    const dict = __gemi_dict__(dictionaryId(TRANSLATIONS), {
      "en-US": () => Promise.reject(new Error("gone")),
    });
    const View = () => <span>{useDictionary(dict)("cta")}</span>;

    const html = await render(
      <App locale="en-US">
        <View />
        <View />
      </App>,
    );

    expect(html.match(/cta/g) ?? []).toHaveLength(2);
  });

  test("a later successful load supersedes the degraded result", async () => {
    let fail = true;
    const dict = __gemi_dict__(dictionaryId(TRANSLATIONS), {
      "en-US": () =>
        fail
          ? Promise.reject(new Error("gone"))
          : Promise.resolve({ default: { cta: "Get started" } }),
    });
    const View = () => <p>{useDictionary(dict)("cta")}</p>;

    await render(
      <App locale="en-US">
        <View />
      </App>,
    );

    fail = false;
    await preloadDictionaries("en-US");

    const html = await render(
      <App locale="en-US">
        <View />
      </App>,
    );
    expect(html).toContain("Get started");
  });
});

describe("the registry's shared state", () => {
  test("lives on globalThis, so duplicate bundles find each other", () => {
    // Not an implementation detail — it is the only thing making the published
    // package work. `gemi/dictionary` ships from the Bun build and
    // `gemi/client`/`gemi/testing` from a separate Vite build, so the registry
    // module is compiled into two bundles; verified against `.publish/`, both
    // carry their own copy. Module scope would give a published app one
    // registry for the views' `__gemi_dict__` and another for `useDictionary`,
    // and the hydration payload would come out empty — passing every test here
    // and failing only once installed.
    defineDictionary(TRANSLATIONS);

    const state = (globalThis as any).__GEMI_DICTIONARY_REGISTRY__;
    expect(state).toBeDefined();
    expect(state.registry.size).toBeGreaterThan(0);
  });
});

describe("a handle whose registry entry has gone", () => {
  test("re-registers itself rather than throwing", async () => {
    // Dictionaries are declared at module scope, so a handle is created once
    // and then outlives anything that clears the registry under it — a test's
    // `afterEach` reset, an HMR boundary. Holding only an id, it would be
    // permanently orphaned and throw "Unknown dictionary" for a dictionary the
    // caller has in its hand.
    const dict = defineDictionary(TRANSLATIONS);
    __resetDictionaryRegistry();

    const View = () => <p>{useDictionary(dict)("cta")}</p>;
    const html = await render(
      <App locale="tr-TR">
        <View />
      </App>,
    );
    expect(html).toContain("Başla");
  });

  test("the same holds for the non-React readers", async () => {
    const dict = defineDictionary(TRANSLATIONS);
    __resetDictionaryRegistry();

    expect(await dict.load("en-US")).toMatchObject({ cta: "Get started" });
    expect(dict.get("en-US")).toMatchObject({ cta: "Get started" });
  });
});

describe("a dictionary inside a dynamically imported component", () => {
  /**
   * The one case no preload can cover. A `lazy()` module does not evaluate — and
   * so does not register its dictionary — until React renders it, which is long
   * after the view router warmed everything it could see. `use()` is the
   * fallback here by design, so what matters is that the fallback is *correct*:
   * the right locale renders, and the strings still reach the client ahead of
   * the segment that used them.
   */
  function lazyView(loaderDelayMs = 0) {
    return lazy(async () => {
      await new Promise((r) => setTimeout(r, loaderDelayMs));
      // Registration happens here, mid-render — exactly like a real chunk
      // evaluating its module-scope `defineDictionary`.
      const dict = __gemi_dict__(dictionaryId(TRANSLATIONS), {
        "en-US": async () => ({ default: localeStrings(TRANSLATIONS, "en-US") }),
        "tr-TR": async () => ({ default: localeStrings(TRANSLATIONS, "tr-TR") }),
      });
      return {
        default: () => <p id="late">{useDictionary(dict)("cta")}</p>,
      };
    });
  }

  test("renders the active locale, not the source language", async () => {
    const Late = lazyView();
    const html = await render(
      <App locale="tr-TR">
        <Late />
      </App>,
    );
    expect(html).toContain("Başla");
    expect(html).not.toContain("Get started");
  });

  test("its strings still reach the hydration payload", async () => {
    // The sink is render-scoped, and this component renders after the shell has
    // flushed — if collection only worked for the shell, hydration would find
    // nothing and refetch the chunk it already has.
    const sink = createDictionarySink();
    const Late = lazyView(5);

    const html = await render(
      <App locale="tr-TR" sink={sink}>
        <Late />
      </App>,
      sink,
    );

    const payload = dictionaryScripts(html);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toContain("Başla");
    expect(payload[0]).not.toContain("Get started");
  });

  test("the payload lands ahead of the segment that used it", async () => {
    // Hydration must never meet revealed markup whose strings are not yet in
    // the registry.
    const sink = createDictionarySink();
    const Late = lazyView(5);

    const html = await render(
      <App locale="en-US" sink={sink}>
        <Late />
      </App>,
      sink,
    );

    const payloadAt = html.indexOf("__GEMI_DICT__");
    const revealAt = html.indexOf("Get started");
    expect(payloadAt).toBeGreaterThan(-1);
    expect(revealAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeLessThan(revealAt);
  });

  test("a failed load degrades to keys rather than killing the boundary", async () => {
    const Late = lazy(async () => {
      const dict = __gemi_dict__("d_lazy_broken", {
        "en-US": () => Promise.reject(new Error("chunk 404")),
      });
      return { default: () => <p>{useDictionary(dict)("cta")}</p> };
    });

    const html = await render(
      <App locale="en-US">
        <Late />
      </App>,
    );
    expect(html).toContain("cta");
    expect(html).not.toContain("chunk 404");
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
