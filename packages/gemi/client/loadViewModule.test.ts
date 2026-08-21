/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from "vitest";

import { __gemi_dict__ } from "../i18n/defineDictionary";
import { __resetDictionaryRegistry } from "../i18n/dictionaryRegistry";
import { loadViewModule, subscribeViewModules } from "./ComponentContext";

/**
 * `loadViewModule` is the one choke point every view chunk passes through, so
 * it is where a view's dictionaries get warmed — and the ordering inside it is
 * load-bearing in two directions at once.
 */

afterEach(() => {
  __resetDictionaryRegistry();
  delete (window as any).loaders;
  delete (window as any).__GEMI_DATA__;
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("loadViewModule", () => {
  test("registers the module before waiting on its dictionaries", async () => {
    // The listener exists so a `Route` that rendered before its module arrived
    // can pick up the view's `Loading` export. Holding it behind the dictionary
    // fetch would put back the `null`-fallback flash it removes — so it has to
    // fire while the dictionary is still in flight, not after.
    const dictChunk = deferred<{ default: Record<string, string> }>();
    const viewModule = {
      default: () => null,
      Loading: () => null,
    };

    (window as any).loaders = {
      Home: async () => {
        __gemi_dict__("d_home", { "en-US": () => dictChunk.promise });
        return viewModule;
      },
    };
    (window as any).__GEMI_DATA__ = { i18n: { currentLocale: "en-US" } };

    let notified = false;
    const unsubscribe = subscribeViewModules(() => {
      notified = true;
    });

    let settled = false;
    const loading = loadViewModule("Home").then((mod) => {
      settled = true;
      return mod;
    });

    // Let the loader run and the module register, but leave the dictionary
    // chunk outstanding.
    await new Promise((r) => setTimeout(r, 0));

    expect(notified).toBe(true);
    expect(settled).toBe(false);

    dictChunk.resolve({ default: { title: "Home" } });
    await expect(loading).resolves.toBe(viewModule);

    unsubscribe();
  });

  test("does not resolve until the view's dictionaries are warm", async () => {
    // The other direction: the returned promise is what `lazy()` suspends on,
    // so folding the dictionary fetch into it means the route shows its own
    // loading state instead of rendering and suspending a beat later.
    const dictChunk = deferred<{ default: Record<string, string> }>();
    (window as any).loaders = {
      Slow: async () => {
        __gemi_dict__("d_slow", { "en-US": () => dictChunk.promise });
        return { default: () => null };
      },
    };
    (window as any).__GEMI_DATA__ = { i18n: { currentLocale: "en-US" } };

    const order: string[] = [];
    const loading = loadViewModule("Slow").then(() => order.push("view"));

    await new Promise((r) => setTimeout(r, 0));
    order.push("dictionary");
    dictChunk.resolve({ default: { title: "Slow" } });
    await loading;

    expect(order).toEqual(["dictionary", "view"]);
  });

  test("a failing dictionary does not fail the view", async () => {
    // A missing chunk should surface at the component that reads it, where the
    // error names the key — not take down an unrelated navigation.
    const viewModule = { default: () => null };
    (window as any).loaders = {
      Broken: async () => {
        __gemi_dict__("d_broken", {
          "en-US": () => Promise.reject(new Error("chunk 404")),
        });
        return viewModule;
      },
    };
    (window as any).__GEMI_DATA__ = { i18n: { currentLocale: "en-US" } };

    await expect(loadViewModule("Broken")).resolves.toBe(viewModule);
  });
});
