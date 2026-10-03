import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * The zone `useFormatter` formats in has to reach the browser with the page,
 * or the client would fall back to a different one than the server rendered
 * with and hydration would find different text. Checked on the `.json`
 * navigation envelope, which carries the same `i18n` object as the document.
 */

process.env.SECRET ??= "time-zone-payload-test-secret";

class RootViewRouter extends ViewRouter {
  routes = { "/about": this.view("About") };
}

class RootApiRouter extends ApiRouter {
  routes = {};
}

function appWith(translation: Record<string, unknown> | undefined) {
  class AppKernel extends Kernel {
    config = {
      ...(translation ? { translation } : {}),
      route: {
        api: { rootRouter: RootApiRouter },
        view: { root: () => createElement("div"), rootRouter: RootViewRouter },
      },
    };
  }
  return new App({ kernel: AppKernel });
}

async function i18nPayload(app: App, headers: Record<string, string> = {}) {
  const res = (await app.fetch(
    new Request("http://gemi.dev/about.json", { headers }),
  )) as Response;
  expect(res).toBeInstanceOf(Response);
  const firstLine = (await res.text()).split("\n")[0];
  return JSON.parse(firstLine).i18n;
}

describe("the page payload's time zone", () => {
  test("is UTC when the app configures nothing — and ships even without i18n", async () => {
    const i18n = await i18nPayload(appWith(undefined));
    expect(i18n.timeZone).toBe("UTC");
    expect(i18n.defaultLocale).toBe("en-US");
    // Not mistaken for a locale-aware app.
    expect(i18n.currentLocale).toBeUndefined();
  });

  test("is the configured zone", async () => {
    const i18n = await i18nPayload(
      appWith({
        supportedLocales: ["en-US", "tr-TR"],
        defaultLocale: "en-US",
        timeZone: "Europe/Istanbul",
      }),
    );
    expect(i18n.timeZone).toBe("Europe/Istanbul");
    expect(i18n.currentLocale).toBe("en-US");
  });

  test("is what detectTimeZone resolves for the request", async () => {
    const app = appWith({
      timeZone: "Europe/Istanbul",
      detectTimeZone: (req: HttpRequest) => req.cookies.get("tz") ?? null,
    });
    expect((await i18nPayload(app, { cookie: "tz=Asia/Tokyo" })).timeZone).toBe("Asia/Tokyo");
    // A forged cookie must not crash the page: it falls back.
    expect((await i18nPayload(app, { cookie: "tz=nowhere" })).timeZone).toBe(
      "Europe/Istanbul",
    );
    expect((await i18nPayload(app)).timeZone).toBe("Europe/Istanbul");
  });
});
