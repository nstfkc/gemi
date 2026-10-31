import { afterAll, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { useDictionary } from "../../client/useDictionary";
import { Lang } from "../../facades/Lang";
import { ApiRouter } from "../../http/ApiRouter";
import { NotFoundError } from "../../http/errors";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { negotiateLocale, resolveLocale } from "../../i18n";
import { defineDictionary } from "../../i18n/defineDictionary";
import { __resetDictionaryRegistry } from "../../i18n/dictionaryRegistry";
import { Kernel } from "../../kernel";
import { ViewRouteDispatcher } from "./ViewRouteDispatcher";

/**
 * `view.detectLocale` (#1092): a `localeRouting: "off"` group picks each
 * request's locale itself, before middleware and whether or not a route
 * matched, so its static not-found page reads `useDictionary` in it too.
 */

process.env.SECRET ??= "detect-locale-test-secret";

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

function ShopNotFound(props: { locale?: string }) {
  const t = useDictionary(dict);
  return <p id="shop-404">{`${t("missing")}|${props.locale ?? ""}`}</p>;
}

function Greeting(props: { text: string }) {
  const t = useDictionary(dict);
  return <main>{`${t("hello")}|${props.text}`}</main>;
}

const views: Record<string, any> = {
  "404": () => <p>app not found</p>,
  Greeting,
  "shop/ShopLayout": ShopLayout,
  "shop/NotFound": ShopNotFound,
};

class ForceGerman extends Middleware {
  run() {
    Lang.setLocale("de-DE", { cookie: false });
  }
}

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
    "/": this.view("Greeting", () => ({ text: Lang.locale() })).static({
      layout: "shop/ShopLayout",
    }),
    "/products/:slug": this.view("Greeting", (req: HttpRequest<any, { slug: string }>) => {
      if (req.params.slug === "gone") throw new NotFoundError();
      return { text: Lang.locale() };
    }).static({ layout: "shop/ShopLayout" }),
    "/german": this.view("Greeting", () => ({ text: Lang.locale() }))
      .middleware(["force-german"])
      .static({ layout: "shop/ShopLayout" }),
    // A hydrated page: its `.json` navigation carries the locale too.
    "/account": this.view("Greeting", () => ({ text: Lang.locale() })),
  };
}

// The storefront's contract: `?locale=` first, then `Accept-Language`.
const detectLocale = vi.fn(
  (req: HttpRequest, { supportedLocales, defaultLocale }: { supportedLocales: string[]; defaultLocale: string }) =>
    resolveLocale(new URL(req.rawRequest.url).searchParams.get("locale"), supportedLocales, defaultLocale) ??
    negotiateLocale(req.headers.get("accept-language"), supportedLocales, defaultLocale),
);

const onNotFound = vi.fn(() => ({ locale: Lang.locale() }));

class TestKernel extends Kernel {
  config = {
    middleware: { aliases: { "force-german": ForceGerman } },
    translation: { supportedLocales: ["en-US", "tr-TR", "de-DE"], defaultLocale: "en-US" },
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(AppLayout), rootRouter: RootViewRouter },
      domains: {
        root: "example.test",
        groups: [
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
          // Out of locale routing, without the hook: unchanged.
          {
            subdomain: "plain",
            view: { rootRouter: ShopViewRouter, localeRouting: "off" as const, detectLocale: undefined },
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
};

async function visit(url: string, headers: Record<string, string> = {}) {
  const answer = await app.fetch(new Request(url, { headers }));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  const body = await res.text();
  return {
    status: res.status,
    location: res.headers.get("location"),
    cookies: res.headers.getSetCookie(),
    body,
    notFound: body.match(/<p id="shop-404">([^<]*)<\/p>/)?.[1] ?? null,
    page: body.match(/<main>([^<]*)<\/main>/)?.[1] ?? null,
  };
}

describe("view.detectLocale on a localeRouting: \"off\" group", () => {
  test("an unmatched path renders the notFound view's dictionary in the detected locale, with no locale cookie", async () => {
    const res = await visit("http://acme.example.test/unknown/path?locale=tr-TR");
    expect(res.status).toBe(404);
    expect(res.notFound).toBe("Sayfa bulunamadı|tr-TR");
    expect(res.body).toContain('data-locale="tr-TR"');
    expect(res.cookies.join("\n")).not.toContain("i18n-locale");
  });

  test("falls back to Accept-Language, then the default locale", async () => {
    const accepted = await visit("http://acme.example.test/nope", {
      "accept-language": "de-AT,de;q=0.9,en;q=0.5",
    });
    expect(accepted.notFound).toBe("Seite nicht gefunden|de-DE");

    const none = await visit("http://acme.example.test/nope");
    expect(none.notFound).toBe("Page not found|en-US");
  });

  test("a handler's NotFoundError renders the notFound view in the detected locale", async () => {
    const res = await visit("http://acme.example.test/products/gone?locale=tr-TR");
    expect(res.status).toBe(404);
    expect(res.notFound).toBe("Sayfa bulunamadı|tr-TR");
  });

  test("a matched route sees it in Lang.locale() and useDictionary", async () => {
    const res = await visit("http://acme.example.test/products/shoes?locale=tr-TR");
    expect(res.status).toBe(200);
    expect(res.page).toBe("Merhaba|tr-TR");
    expect(res.location).toBeNull();
    expect(res.cookies.join("\n")).not.toContain("i18n-locale");
  });

  test("a .json navigation carries it in i18n", async () => {
    const answer = await app.fetch(new Request("http://acme.example.test/account.json?locale=tr-TR"));
    const envelope = JSON.parse((await (answer as Response).text()).split("\n")[0]);
    expect(envelope.i18n.currentLocale).toBe("tr-TR");
    expect(envelope.i18n.localeRouting).toBe("off");
  });

  test("middleware calling Lang.setLocale overrides it", async () => {
    const res = await visit("http://acme.example.test/german?locale=tr-TR");
    expect(res.page).toBe("Hallo|de-DE");
  });

  test("a short tag resolves to its supported locale; an unsupported or malformed one leaves the default", async () => {
    expect((await visit("http://acme.example.test/?locale=de")).page).toBe("Hallo|de-DE");
    for (const value of ["fr-FR", "not a locale", ""]) {
      const res = await visit(`http://acme.example.test/?locale=${encodeURIComponent(value)}`);
      expect(res.page).toBe("Hello|en-US");
    }
  });

  test("a hook that returns an unsupported locale or a non-string leaves the default", async () => {
    detectLocale.mockReturnValueOnce("fr-FR");
    expect((await visit("http://acme.example.test/")).page).toBe("Hello|en-US");
    detectLocale.mockReturnValueOnce(["tr-TR"] as any);
    expect((await visit("http://acme.example.test/")).page).toBe("Hello|en-US");
  });

  test("a group without it still renders in the default locale", async () => {
    const res = await visit("http://plain.example.test/?locale=tr-TR", { "accept-language": "tr-TR" });
    expect(res.page).toBe("Hello|en-US");
  });
});

describe("view.detectLocale on locale-routed views", () => {
  test("fails at boot", () => {
    expect(
      () =>
        new ViewRouteDispatcher({
          root: createRoot(AppLayout),
          rootRouter: RootViewRouter,
          detectLocale: () => "tr-TR",
        }),
    ).toThrow('`view.detectLocale` needs `view.localeRouting: "off"`');
  });
});
