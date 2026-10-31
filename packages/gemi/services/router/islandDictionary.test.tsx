import type { ReactNode } from "react";
import { afterAll, describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { island } from "../../client/islands";
import { Lang } from "../../facades/Lang";
import { ApiRouter } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { resolveLocale } from "../../i18n";
import { __resetDictionaryRegistry } from "../../i18n/dictionaryRegistry";
import { Kernel } from "../../kernel";
import * as Cart from "./__fixtures__/islands/Cart";

/**
 * `useDictionary` inside an island on a static page (#1095), on the server:
 * the island renders in the page's locale, however the page got it, and the
 * document carries the strings it read. `islandDictionary.browser.test.tsx`
 * hydrates such a document.
 */

process.env.SECRET ??= "island-dictionary-test-secret";

/** What gemi's Vite plugin turns `island(() => import("./x"))`'s loader into. */
const viaPlugin = (key: string, mod: Record<string, unknown>) =>
  Object.assign(() => Promise.resolve(mod), { gemiIsland: key, gemiModule: mod }) as () => Promise<any>;

const VatLine = island(viaPlugin("app/views/shop/Cart.tsx", Cart));
const PlainCounter = island(viaPlugin("app/views/shop/Cart.tsx", Cart), { export: "PlainCounter" });
const Amount = island(viaPlugin("app/views/shop/Cart.tsx", Cart), { export: "Amount" });

const Layout = (props: { children?: ReactNode }) => (
  <html>
    <Head />
    <body>{props.children}</body>
  </html>
);

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  "shop/Layout": Layout,
  "shop/Cart": () => (
    <main>
      <VatLine rate={18} />
      <VatLine rate={8} />
    </main>
  ),
  "shop/Plain": () => (
    <main>
      <PlainCounter start={1} />
    </main>
  ),
  "shop/Amount": () => (
    <main>
      <Amount />
    </main>
  ),
};

class ForceGerman extends Middleware {
  run() {
    Lang.setLocale("de-DE", { cookie: false });
  }
}

class ShopViewRouter extends ViewRouter {
  override routes = {
    "/cart": this.view("shop/Cart").static({ layout: "shop/Layout" }),
    "/plain": this.view("shop/Plain").static({ layout: "shop/Layout" }),
    "/amount": this.view("shop/Amount").static({ layout: "shop/Layout" }),
  };
}

class GermanViewRouter extends ViewRouter {
  override routes = {
    "/cart": this.view("shop/Cart").middleware(["force-german"]).static({ layout: "shop/Layout" }),
  };
}

class RootApiRouter extends ApiRouter {
  routes = {};
}

class TestKernel extends Kernel {
  config = {
    middleware: { aliases: { "force-german": ForceGerman } },
    translation: { supportedLocales: ["en-US", "tr-TR", "de-DE"], defaultLocale: "en-US" },
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(Layout as any), rootRouter: ShopViewRouter },
      domains: {
        root: "example.test",
        groups: [
          // Out of locale routing; middleware picks the locale.
          {
            subdomain: "de",
            view: { rootRouter: GermanViewRouter, localeRouting: "off" as const, theme: false as const },
          },
          // Out of locale routing; `view.detectLocale` picks it from `?locale=`.
          {
            subdomain: "shop",
            view: {
              rootRouter: ShopViewRouter,
              localeRouting: "off" as const,
              theme: false as const,
              detectLocale: (req: HttpRequest, o: { supportedLocales: string[]; defaultLocale: string }) =>
                resolveLocale(
                  new URL(req.rawRequest.url).searchParams.get("locale"),
                  o.supportedLocales,
                  o.defaultLocale,
                ),
            },
          },
        ],
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

const params = {
  getStyles: async () => [],
  viewImportMap: views,
  viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
  clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js"] },
  modulePreloadManifest: {},
  resolveIsland: (key: string) =>
    key === "app/views/shop/Cart.tsx" ? { src: "/assets/Cart.js", preload: ["/assets/Cart.js"] } : undefined,
};

async function fetchDocument(url: string) {
  const answer = await app.fetch(new Request(url));
  expect(typeof answer).toBe("function");
  const res = (await (answer as any)(params)) as Response;
  expect(res.status).toBe(200);
  return await res.text();
}

const payload = (html: string) => {
  const json = html.match(/<script type="application\/json" id="gemi-island-i18n">(.*?)<\/script>/)?.[1];
  return json === undefined ? undefined : JSON.parse(json);
};

const outputs = (html: string) => [...html.matchAll(/<output>([^<]*)<\/output>/g)].map((m) => m[1]);

afterAll(() => {
  __resetDictionaryRegistry();
});

describe("useDictionary in an island on a static page", () => {
  test("renders in the page's locale and carries the strings it read, once", async () => {
    const html = await fetchDocument("http://example.test/tr-TR/cart");
    expect(outputs(html)).toEqual(["KDV (%18)", "KDV (%8)"]);
    expect(payload(html)).toEqual({
      currentLocale: "tr-TR",
      defaultLocale: "en-US",
      timeZone: expect.any(String),
      dictionaries: [[Cart.cartDict.id, "tr-TR", Cart.strings["tr-TR"]]],
    });
    // Next to the island table, before the loader.
    expect(html.indexOf('id="gemi-islands"')).toBeLessThan(html.indexOf('id="gemi-island-i18n"'));
    expect(html.indexOf('id="gemi-island-i18n"')).toBeLessThan(html.indexOf('<script type="module">'));
  });

  test("carries no payload when the page's islands read no i18n", async () => {
    const html = await fetchDocument("http://example.test/tr-TR/plain");
    expect(html).toContain('id="gemi-islands"');
    expect(html).not.toContain("gemi-island-i18n");
    expect(html).not.toContain("__GEMI_DICT__");
  });

  test("an island that only formats gets the locale and zone, and no dictionaries", async () => {
    const html = await fetchDocument("http://example.test/de-DE/amount");
    expect(html).toContain("<data>1.234,5</data>");
    expect(payload(html)).toEqual({
      currentLocale: "de-DE",
      defaultLocale: "en-US",
      timeZone: expect.any(String),
    });
  });

  test('follows a locale middleware set with Lang.setLocale(…, { cookie: false }) on a localeRouting: "off" group', async () => {
    const html = await fetchDocument("http://de.example.test/cart");
    expect(outputs(html)).toEqual(["MwSt. (18 %)", "MwSt. (8 %)"]);
    expect(payload(html).currentLocale).toBe("de-DE");
    expect(payload(html).dictionaries).toEqual([[Cart.cartDict.id, "de-DE", Cart.strings["de-DE"]]]);
  });

  test("follows view.detectLocale", async () => {
    const html = await fetchDocument("http://shop.example.test/cart?locale=tr-TR");
    expect(outputs(html)).toEqual(["KDV (%18)", "KDV (%8)"]);
    expect(payload(html).currentLocale).toBe("tr-TR");

    const fallback = await fetchDocument("http://shop.example.test/cart");
    expect(outputs(fallback)).toEqual(["VAT (18%)", "VAT (8%)"]);
    expect(payload(fallback).currentLocale).toBe("en-US");
  });
});
