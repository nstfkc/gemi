import { describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { Lang } from "../../facades/Lang";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * #948: a locale's root URL without its trailing slash (`/de-DE`) keyed its
 * view's data under `""` instead of `/`, so the view hydrated without props.
 */

process.env.SECRET ??= "locale-root-page-data-test-secret";

const Layout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>{props.children}</body>
  </html>
);

const Page = (props: { text: string }) => <main>{props.text}</main>;

const views: Record<string, any> = { "404": () => <p>not found</p>, Page };

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Page", () => ({ text: `home in ${Lang.locale()}` })),
    "/about": this.view("Page", () => ({ text: `about in ${Lang.locale()}` })),
    // Starts like the `de-DE` locale but is a route of its own.
    "/de-DE-shop": this.view("Page", () => ({ text: `shop in ${Lang.locale()}` })),
  };
}

class TestKernel extends Kernel {
  config = {
    translation: { supportedLocales: ["en-US", "de-DE"], defaultLocale: "en-US" },
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(Layout), rootRouter: RootViewRouter },
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

async function visit(path: string) {
  const answer = await app.fetch(new Request(`http://localhost${path}`));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

/** The document payload's `pageData` key and the props the view got under it. */
function pageData(body: string) {
  const match = body.match(/"pageData":\{"([^"]*)":\{"Page":\{"text":"([^"]*)"/);
  expect(match, "document payload carries pageData").not.toBeNull();
  return { key: match![1], text: match![2] };
}

describe("page data key on locale-prefixed URLs", () => {
  test.each([
    ["/de-DE", "/", "home in de-DE"],
    ["/de-DE/", "/", "home in de-DE"],
    ["/de-DE/about", "/about", "about in de-DE"],
    ["/", "/", "home in en-US"],
    ["/about", "/about", "about in en-US"],
    ["/de-DE-shop", "/de-DE-shop", "shop in en-US"],
  ])("%s keys its view data under %s", async (path, key, text) => {
    const res = await visit(path);
    expect(res.status).toBe(200);
    expect(res.location).toBeNull();
    expect(pageData(res.body)).toEqual({ key, text });
  });

  test("the .json data for the locale root is keyed the same way", async () => {
    const res = await visit("/de-DE.json");
    expect(res.status).toBe(200);
    expect(res.body).toContain(`"data":{"/":{"Page":{"text":"home in de-DE"`);
  });
});
