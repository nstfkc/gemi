import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

process.env.SECRET ??= "locale-redirect-test-secret";

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/about": this.view("About"),
    // First segments that parse as a locale tag: `de-luxe` is the language
    // `de` with a legal 4-letter subtag, `en-suite` the same for `en`.
    "/de-luxe": this.view("DeLuxe"),
    "/en-suite": this.view("EnSuite"),
    "/en-suite/x": this.view("EnSuiteX"),
    "/tr": this.view("Tr"),
  };
}

class RootApiRouter extends ApiRouter {
  routes = {};
}

class AppKernel extends Kernel {
  config = {
    translation: { supportedLocales: ["en-US", "de-DE"], defaultLocale: "en-US" },
    route: {
      // `route.api` is required of every app, and `RouteServiceProvider` builds
      // both dispatchers at boot — so a kernel that declares only `view` does
      // not boot, however few api routes it has.
      api: { rootRouter: RootApiRouter },
      view: { root: () => createElement("div"), rootRouter: RootViewRouter },
    },
  };
}

const app = new App({ kernel: AppKernel });

async function fetchView(path: string, headers: Record<string, string> = {}) {
  return (await app.fetch(new Request(`http://gemi.dev${path}`, { headers }))) as unknown;
}

describe("a locale prefix the app can map onto a supported locale", () => {
  test.each([
    ["/en", "/en-US"],
    ["/en/about", "/en-US/about"],
    ["/de-AT/about?x=1", "/de-DE/about?x=1"],
    ["/de-at/about", "/de-DE/about"],
    ["/de/about.json", "/de-DE/about.json"],
  ])("redirects %s to %s", async (from, to) => {
    const res = await fetchView(from);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe(to);
  });

  test("leaves a supported locale and a plain path alone", async () => {
    expect(await fetchView("/de-DE/about")).toBeTypeOf("function");
    expect(await fetchView("/about", { "accept-language": "en-US" })).toBeTypeOf("function");
  });

  /**
   * The tag pattern cannot tell these from a locale — `de-luxe` really is a
   * well-formed language-plus-subtag — so route existence is what decides.
   * Before this, `/de-luxe` answered `302 /de-DE` and the page was gone: not
   * even moved, since the segment is dropped rather than kept.
   */
  test.each(["/de-luxe", "/en-suite", "/en-suite/x", "/de-luxe?a=1", "/tr"])(
    "renders %s, which is a route whose first segment merely looks like a locale",
    async (path) => {
      expect(await fetchView(path)).toBeTypeOf("function");
    },
  );

  test("still redirects a locale-shaped segment that is not a route", async () => {
    const res = await fetchView("/de-lux");
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/de-DE");
  });

  /**
   * The locale is negotiated per visitor — from the cookie and
   * `Accept-Language` — so a shared cache or CDN storing this redirect would
   * serve one visitor's locale to the next.
   */
  test("the redirect is not cacheable", async () => {
    const res = (await fetchView("/en/about")) as Response;
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  /** An Open Graph image is fetched by a crawler that will not follow a hop. */
  test("an .og request is rendered, not redirected", async () => {
    expect(await fetchView("/en/about.og")).toBeTypeOf("function");
  });

  test("does not redirect a language the app doesn't support", async () => {
    const res = await fetchView("/fr/about");
    expect((res as Response).headers?.get("Location") ?? null).toBeNull();
  });
});
