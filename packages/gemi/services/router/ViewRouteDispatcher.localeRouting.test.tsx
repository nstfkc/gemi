import { describe, expect, test } from "vitest";
import type { ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { resolveHtmlAttributes, textDirection, type RootLayoutProps } from "../../client/htmlAttributes";
import { Lang } from "../../facades/Lang";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { resolveLocale } from "../../i18n";
import { Kernel } from "../../kernel";

/**
 * Opting out of locale routing (#842): a `route.domains` group whose pages are
 * not the app's own UI (user-published sites), and single routes marked
 * `"no-locale"`, in an app whose `translation` configures locales. Full
 * requests through `app.fetch`, since the redirect is the bug.
 */

process.env.SECRET ??= "locale-routing-test-secret";

const AppLayout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes} data-locale={props.locale}>
    <Head />
    <body data-layout="app">{props.children}</body>
  </html>
);

const SiteLayout = (props: { children: ReactNode } & Pick<RootLayoutProps, "htmlAttributes">) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body data-layout="site">{props.children}</body>
  </html>
);

const Page = (props: { text: string }) => <main>{props.text}</main>;

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  "site/Layout": SiteLayout,
  "site/Page": Page,
  Page,
};

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Page", () => ({ text: `home in ${Lang.locale()}` })),
    "/about": this.view("Page", () => ({ text: `about in ${Lang.locale()}` })),
    "/embed": this.view("Page", () => ({ text: `embed in ${Lang.locale()}` })).middleware([
      "no-locale",
    ]),
  };
}

// A published site: its paths are its own, whatever they look like.
class SiteViewRouter extends ViewRouter {
  override routes = {
    "/": this.page(),
    "/:path*": this.page(),
  };

  private page() {
    return this.view("site/Page", (req) => {
      const path = new URL(req.rawRequest.url).pathname;
      if (path === "/turkce") {
        Meta.htmlAttributes({ lang: "tr" });
        Meta.canonical("https://acme.example.test/turkce");
        Meta.alternates([
          { hrefLang: "tr", href: "https://acme.example.test/turkce" },
          { hrefLang: "en", href: "https://acme.example.test/" },
        ]);
      }
      if (path === "/arabic") {
        Meta.htmlAttributes({ lang: "ar" });
      }
      return { text: `site ${path} in ${Lang.locale()}` };
    }).static({ layout: "site/Layout" });
  }
}

class TestKernel extends Kernel {
  config = {
    translation: { supportedLocales: ["en-US", "tr-TR"], defaultLocale: "en-US" },
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(AppLayout), rootRouter: RootViewRouter },
      domains: {
        root: "example.test",
        groups: [
          {
            subdomain: ":site",
            view: { rootRouter: SiteViewRouter, localeRouting: "off" as const },
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

const turkish = { "accept-language": "tr-TR,tr;q=0.9" };

async function visit(url: string, headers: Record<string, string> = {}) {
  const answer = await app.fetch(new Request(url, { headers }));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  const body = await res.text();
  return {
    status: res.status,
    location: res.headers.get("location"),
    setCookie: res.headers.get("set-cookie") ?? "",
    body,
    html: body.match(/<html[^>]*>/)?.[0] ?? "",
  };
}

describe("a domain group with localeRouting: \"off\"", () => {
  test("does not redirect a visitor whose browser or cookie prefers another locale", async () => {
    for (const headers of [turkish, { cookie: "i18n-locale=tr-TR" }]) {
      for (const path of ["/", "/about"]) {
        const res = await visit(`http://acme.example.test${path}`, headers);
        expect(res.status).toBe(200);
        expect(res.location).toBeNull();
        expect(res.body).toContain(`site ${path} in en-US`);
      }
    }
  });

  test("treats a locale-shaped first segment as an ordinary path", async () => {
    for (const path of ["/tr-TR/menu", "/tr/menu", "/de-AT"]) {
      const res = await visit(`http://acme.example.test${path}`, turkish);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`site ${path} in en-US`);
    }
  });

  test("renders one body for everyone: the default locale's lang, no locale cookie", async () => {
    const tr = await visit("http://acme.example.test/", turkish);
    const en = await visit("http://acme.example.test/", { "accept-language": "en-US" });
    expect(tr.html).toBe('<html lang="en-US" dir="ltr">');
    expect(tr.body).toBe(en.body);
    expect(tr.setCookie).not.toContain("i18n-locale");
  });

  test("takes <html lang>, dir, canonical and alternates from Meta", async () => {
    const res = await visit("http://acme.example.test/turkce", turkish);
    expect(res.html).toBe('<html lang="tr" dir="ltr">');
    expect(res.body).toContain('<link rel="canonical" href="https://acme.example.test/turkce" data-gemi-meta=""/>');
    expect(res.body).toContain(
      '<link rel="alternate" href="https://acme.example.test/turkce" hrefLang="tr" data-gemi-meta=""/>',
    );
    expect(res.body).toContain(
      '<link rel="alternate" href="https://acme.example.test/" hrefLang="en" data-gemi-meta=""/>',
    );

    const ar = await visit("http://acme.example.test/arabic");
    expect(ar.html).toBe('<html lang="ar" dir="rtl">');
  });
});

describe("the app's own hosts keep locale routing", () => {
  test("redirects a Turkish visitor and renders the prefixed page in Turkish", async () => {
    const redirect = await visit("http://example.test/about", turkish);
    expect(redirect.status).toBe(302);
    expect(redirect.location).toBe("/tr-TR/about");

    const page = await visit("http://example.test/tr-TR/about", turkish);
    expect(page.status).toBe(200);
    expect(page.body).toContain("about in tr-TR");
    expect(page.html).toContain('lang="tr-TR"');
    expect(page.html).toContain('data-locale="tr-TR"');
  });

  test("a \"no-locale\" route is neither redirected nor served under a prefix", async () => {
    const res = await visit("http://example.test/embed", turkish);
    expect(res.status).toBe(200);
    expect(res.location).toBeNull();
    expect(res.body).toContain("embed in en-US");
    expect(res.setCookie).not.toContain("i18n-locale");

    const prefixed = await visit("http://example.test/tr-TR/embed", turkish);
    expect(prefixed.status).toBe(404);
  });
});

describe("helpers", () => {
  test("textDirection reads the primary language", () => {
    expect(textDirection("ar-EG")).toBe("rtl");
    expect(textDirection("he")).toBe("rtl");
    expect(textDirection("tr-TR")).toBe("ltr");
    expect(textDirection(undefined)).toBe("ltr");
  });

  test("resolveHtmlAttributes prefers what was set, else the locale", () => {
    expect(resolveHtmlAttributes(null, "fa-IR")).toEqual({ lang: "fa-IR", dir: "rtl" });
    expect(resolveHtmlAttributes({ lang: "en", dir: "auto" }, "fa-IR")).toEqual({
      lang: "en",
      dir: "auto",
    });
  });

  test("resolveLocale is exported from gemi/i18n", () => {
    expect(resolveLocale("tr", ["en-US", "tr-TR"])).toBe("tr-TR");
  });
});
