import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Query } from "../../facades/Prefetch";
import { ApiRouter } from "../../http/ApiRouter";
import { HttpRequest } from "../../http/HttpRequest";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A server-side query runs its api route in a request context of its own. It
 * must see the locale the page renders in — URL prefix first, then the
 * `i18n-locale` cookie, then `accept-language` — or SSR data comes back in
 * the default locale and flips on the first client refetch (#1074).
 */

process.env.SECRET ??= "server-query-locale-test-secret";

class RootApiRouter extends ApiRouter {
  routes = {
    "/locale": this.get((req = new HttpRequest()) => ({ locale: req.locale() ?? "none" })),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/instant": this.view("Page", async () => ({
      Page: await (Query as any).instant("/locale"),
    })),
    "/prefetch": this.view("Page", () => {
      (Query as any).prefetch("/locale");
      return {};
    }),
  };
}

function makeApp(translation?: Record<string, unknown>) {
  class TestKernel extends Kernel {
    config = {
      ...(translation ? { translation } : {}),
      route: {
        api: { rootRouter: RootApiRouter },
        view: { root: createRoot(() => createElement("div")), rootRouter: RootViewRouter },
      },
    };
  }
  return new App({ kernel: TestKernel as any });
}

const i18nApp = makeApp({ supportedLocales: ["en-US", "tr-TR"], defaultLocale: "en-US" });
const plainApp = makeApp();

async function viewData(app: App, path: string, headers: Record<string, string> = {}) {
  const result: unknown = await app.fetch(new Request(`http://gemi.dev${path}.json`, { headers }));
  expect(result).toBeInstanceOf(Response);
  const res = result as Response;
  return { status: res.status, body: await res.text() };
}

const trCookie = { cookie: "i18n-locale=tr-TR" };

describe("a server-side query's locale", () => {
  test("is the URL prefix's", async () => {
    for (const view of ["/instant", "/prefetch"]) {
      const res = await viewData(i18nApp, `/tr-TR${view}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain('"locale":"tr-TR"');
      expect(res.body).not.toContain('"locale":"en-US"');
    }
  });

  test("keeps the URL prefix over a cookie for another locale", async () => {
    const res = await viewData(i18nApp, "/en-US/instant", trCookie);
    expect(res.body).toContain('"locale":"en-US"');
    expect(res.body).not.toContain('"locale":"tr-TR"');
  });

  test("is the cookie's without a prefix", async () => {
    // The default locale is served unprefixed, so a tr-TR cookie at `/instant`
    // would be redirected first; the cookie naming the default locale is the
    // case that renders without a prefix.
    const res = await viewData(i18nApp, "/instant", {
      cookie: "i18n-locale=en-US",
      "accept-language": "tr-TR",
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"locale":"en-US"');
  });

  test("is the same one the api route answers with", async () => {
    const api: unknown = await i18nApp.fetch(new Request("http://gemi.dev/api/locale", { headers: trCookie }));
    expect(await (api as Response).json()).toMatchObject({ locale: "tr-TR" });
    const ssr = await viewData(i18nApp, "/tr-TR/instant", trCookie);
    expect(ssr.body).toContain('"locale":"tr-TR"');
  });

  test("stays unset with i18n off, as it was", async () => {
    const res = await viewData(plainApp, "/instant", trCookie);
    expect(res.status).toBe(200);
    expect(res.body).toContain('"locale":"none"');
  });
});
