import { afterAll, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { island } from "../../client/islands";
import { useDictionary } from "../../client/useDictionary";
import { Lang } from "../../facades/Lang";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { ViewRouter } from "../../http/ViewRouter";
import { negotiateLocale, resolveLocale } from "../../i18n";
import { defineDictionary } from "../../i18n/defineDictionary";
import { __resetDictionaryRegistry } from "../../i18n/dictionaryRegistry";
import { Kernel } from "../../kernel";
import { RecordNotFoundError } from "../../orm/errors";
import * as Cart from "./__fixtures__/islands/Cart";

/**
 * `onNotFound` picks the not-found page's locale (#1099). On a
 * `localeRouting: "off"` group whose pages read the locale from `?locale=`
 * only, the 404 falls back to `Accept-Language`: a rule `detectLocale` can't
 * express, as it runs before anyone knows the request ends on the 404.
 */

process.env.SECRET ??= "not-found-locale-test-secret";

const dict = defineDictionary({
  missing: { "en-US": "Page not found", "tr-TR": "Sayfa bulunamadı", "de-DE": "Seite nicht gefunden" },
  hello: { "en-US": "Hello", "tr-TR": "Merhaba", "de-DE": "Hallo" },
});

afterAll(() => {
  __resetDictionaryRegistry();
});

const AppLayout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>{props.children}</body>
  </html>
);

const ShopLayout = (props: { children?: ReactNode; locale?: string }) => (
  <html data-layout="shop" data-locale={props.locale}>
    <Head />
    <body>{props.children}</body>
  </html>
);

/** What gemi's Vite plugin turns `island(() => import("./x"))`'s loader into. */
const VatLine = island(
  Object.assign(() => Promise.resolve(Cart), {
    gemiIsland: "app/views/shop/Cart.tsx",
    gemiModule: Cart,
  }) as () => Promise<any>,
);

function ShopNotFound(props: { locale?: string }) {
  const t = useDictionary(dict);
  return (
    <>
      <p id="shop-404">{`${t("missing")}|${props.locale ?? ""}`}</p>
      <VatLine rate={18} />
    </>
  );
}

function AppNotFound() {
  const t = useDictionary(dict);
  return <p id="app-404">{t("missing")}</p>;
}

function Greeting(props: { text: string }) {
  const t = useDictionary(dict);
  return <main>{`${t("hello")}|${props.text}`}</main>;
}

const views: Record<string, any> = {
  "404": AppNotFound,
  Greeting,
  "shop/ShopLayout": ShopLayout,
  "shop/NotFound": ShopNotFound,
};

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Greeting", () => ({ text: Lang.locale() })),
  };
}

class ShopViewRouter extends ViewRouter {
  override routes = {
    // An unknown org on `/`: a matched route whose handler finds nothing.
    "/": this.view("Greeting", (req: HttpRequest) => {
      if (req.domain?.params.shop === "gone") throw new RecordNotFoundError("Org", "findUniqueOrThrow");
      return { text: Lang.locale() };
    }).static({ layout: "shop/ShopLayout" }),
    "/account": this.view("Greeting", () => ({ text: Lang.locale() })),
    // A handler that picks a locale, then finds nothing.
    "/switch": this.view("Greeting", () => {
      Lang.setLocale("de-DE", { cookie: false });
      throw new RecordNotFoundError("Org", "findUniqueOrThrow");
    }),
  };
}

// Pages: `?locale=` only.
const detectLocale = (
  req: HttpRequest,
  { supportedLocales, defaultLocale }: { supportedLocales: string[]; defaultLocale: string },
) => resolveLocale(new URL(req.rawRequest.url).searchParams.get("locale"), supportedLocales, defaultLocale);

// The 404: `?locale=`, else `Accept-Language`.
const onNotFound = vi.fn((req: HttpRequest) => {
  if (!new URL(req.rawRequest.url).searchParams.get("locale")) {
    const locale =
      negotiateLocale(req.headers.get("accept-language"), Lang.getSupportedLocales(), Lang.getDefaultLocale()) ??
      Lang.getDefaultLocale();
    Lang.setLocale(locale, { cookie: false });
  }
  Meta.title(`404 in ${Lang.locale()}`);
  return { locale: Lang.locale() };
});

class TestKernel extends Kernel {
  config = {
    translation: { supportedLocales: ["en-US", "tr-TR", "de-DE"], defaultLocale: "en-US" },
    route: {
      api: { rootRouter: RootApiRouter },
      // Locale-routed: the URL decides, whatever `onNotFound` sets.
      view: {
        root: createRoot(AppLayout),
        rootRouter: RootViewRouter,
        onNotFound: () => {
          Lang.setLocale("tr-TR", { cookie: false });
        },
      },
      domains: {
        root: "example.test",
        groups: [
          {
            subdomain: "hydrated",
            view: { rootRouter: ShopViewRouter, localeRouting: "off" as const, detectLocale, onNotFound },
          },
          {
            subdomain: "plain",
            view: {
              rootRouter: ShopViewRouter,
              localeRouting: "off" as const,
              theme: false as const,
              detectLocale,
              onNotFound: () => ({ locale: Lang.locale() }),
              notFound: { view: "shop/NotFound", static: { layout: "shop/ShopLayout" } },
            },
          },
          {
            subdomain: ":shop",
            view: {
              rootRouter: ShopViewRouter,
              localeRouting: "off" as const,
              theme: false as const,
              detectLocale,
              onNotFound,
              notFound: { view: "shop/NotFound", static: { layout: "shop/ShopLayout" } },
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

async function visit(url: string, headers: Record<string, string> = {}) {
  const answer = await app.fetch(new Request(url, { headers }));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  const body = await res.text();
  return {
    status: res.status,
    cookies: res.headers.getSetCookie(),
    body,
    notFound: body.match(/<p id="shop-404">([^<]*)<\/p>/)?.[1] ?? null,
    appNotFound: body.match(/<p id="app-404">([^<]*)<\/p>/)?.[1] ?? null,
    page: body.match(/<main>([^<]*)<\/main>/)?.[1] ?? null,
    title: body.match(/<title>([^<]*)<\/title>/)?.[1] ?? null,
    island: body.match(/<output>([^<]*)<\/output>/)?.[1] ?? null,
    islandI18n: JSON.parse(
      body.match(/<script type="application\/json" id="gemi-island-i18n">(.*?)<\/script>/)?.[1] ?? "null",
    ),
  };
}

const turkish = { "accept-language": "tr-TR,tr;q=0.9,en;q=0.5" };

describe("onNotFound picks the not-found page's locale (localeRouting: \"off\")", () => {
  test("an unmatched path renders the static notFound view in it, with no locale cookie", async () => {
    const res = await visit("http://acme.example.test/unknown/path", turkish);
    expect(res.status).toBe(404);
    expect(res.notFound).toBe("Sayfa bulunamadı|tr-TR");
    expect(res.body).toContain('data-locale="tr-TR"');
    expect(res.title).toBe("404 in tr-TR");
    expect(res.cookies.join("\n")).not.toContain("i18n-locale");
  });

  test("an island on the static notFound page follows it", async () => {
    const res = await visit("http://acme.example.test/unknown/path", turkish);
    expect(res.island).toBe("KDV (%18)");
    expect(res.islandI18n).toMatchObject({
      currentLocale: "tr-TR",
      dictionaries: [[Cart.cartDict.id, "tr-TR", Cart.strings["tr-TR"]]],
    });

    const english = await visit("http://plain.example.test/nope");
    expect(english.island).toBe("VAT (18%)");
    expect(english.islandI18n.currentLocale).toBe("en-US");
  });

  test("a matched handler's Lang.setLocale before its not-found holds on the 404", async () => {
    // The locale current when the request ended, whoever set it.
    const res = await visit("http://plain.example.test/switch", turkish);
    expect(res.status).toBe(404);
    expect(res.notFound).toBe("Seite nicht gefunden|de-DE");
  });

  test("a matched route whose handler throws RecordNotFoundError renders in it too", async () => {
    const res = await visit("http://gone.example.test/", turkish);
    expect(res.status).toBe(404);
    expect(res.notFound).toBe("Sayfa bulunamadı|tr-TR");
    expect(res.cookies.join("\n")).not.toContain("i18n-locale");
  });

  test("matched pages keep the locale detectLocale picked, whatever Accept-Language says", async () => {
    expect((await visit("http://acme.example.test/", turkish)).page).toBe("Hello|en-US");
    expect((await visit("http://acme.example.test/?locale=de-DE", turkish)).page).toBe("Hallo|de-DE");
  });

  test("a 404 with ?locale= keeps detectLocale's locale when onNotFound leaves it", async () => {
    const res = await visit("http://acme.example.test/nope?locale=de-DE", turkish);
    expect(res.notFound).toBe("Seite nicht gefunden|de-DE");
  });

  test("without a Lang.setLocale in onNotFound the not-found page keeps detectLocale's locale", async () => {
    expect((await visit("http://plain.example.test/nope", turkish)).notFound).toBe("Page not found|en-US");
    expect((await visit("http://plain.example.test/nope?locale=tr-TR")).notFound).toBe(
      "Sayfa bulunamadı|tr-TR",
    );
  });

  test("the app's hydrated 404 renders in it, with its lang attribute", async () => {
    const res = await visit("http://hydrated.example.test/nope", turkish);
    expect(res.status).toBe(404);
    expect(res.appNotFound).toBe("Sayfa bulunamadı");
    expect(res.body).toContain('lang="tr-TR"');
  });

  test("a .json navigation to a 404 carries it in i18n; a matched one does not", async () => {
    const envelope = async (url: string) => {
      const answer = await app.fetch(new Request(url, { headers: turkish }));
      return JSON.parse((await (answer as Response).text()).split("\n")[0]);
    };
    const missing = await envelope("http://hydrated.example.test/nope.json");
    expect(missing.is404).toBe(true);
    expect(missing.i18n.currentLocale).toBe("tr-TR");
    expect(missing.i18n.localeRouting).toBe("off");

    const page = await envelope("http://hydrated.example.test/account.json");
    expect(page.i18n.currentLocale).toBe("en-US");
  });
});

describe("onNotFound on locale-routed views", () => {
  test("Lang.setLocale there leaves the page in the URL's locale", async () => {
    const plain = await visit("http://example.test/nope");
    expect(plain.status).toBe(404);
    expect(plain.appNotFound).toBe("Page not found");
    expect(plain.body).toContain('lang="en-US"');

    const german = await visit("http://example.test/de-DE/nope");
    expect(german.appNotFound).toBe("Seite nicht gefunden");
    expect(german.body).toContain('lang="de-DE"');

    const answer = await app.fetch(new Request("http://example.test/de-DE/nope.json"));
    const envelope = JSON.parse((await (answer as Response).text()).split("\n")[0]);
    expect(envelope.is404).toBe(true);
    expect(envelope.i18n.currentLocale).toBe("de-DE");
  });
});
