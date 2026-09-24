import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

process.env.SECRET ??= "locale-redirect-test-secret";

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/about": this.view("About"),
  };
}

class AppKernel extends Kernel {
  config = {
    translation: { supportedLocales: ["en-US", "de-DE"], defaultLocale: "en-US" },
    route: {
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

  test("does not redirect a language the app doesn't support", async () => {
    const res = await fetchView("/fr/about");
    expect((res as Response).headers?.get("Location") ?? null).toBeNull();
  });
});
