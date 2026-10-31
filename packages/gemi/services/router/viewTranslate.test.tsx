import { describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * `route.view.translate` and `Meta.translate` (#1087): a group (or a page)
 * may leave out `<meta name="google" content="notranslate">`.
 */

process.env.SECRET ??= "view-translate-test-secret";

const NOTRANSLATE = '<meta name="google" content="notranslate"/>';

const Layout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>{props.children}</body>
  </html>
);

const Page = () => <main>page</main>;
const views: Record<string, any> = { "404": () => <p>not found</p>, Page, Layout };

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Page"),
    "/allows": this.view("Page", () => {
      Meta.translate();
      return {};
    }),
  };
}

class ShopViewRouter extends ViewRouter {
  override routes = {
    "/": this.view("Page"),
    "/static": this.view("Page", () => ({})).static({ layout: "Layout" }),
    "/keeps": this.view("Page", () => {
      Meta.translate(false);
      return {};
    }),
  };
}

const app = new App({
  kernel: class extends Kernel {
    config = {
      route: {
        api: { rootRouter: RootApiRouter },
        view: { root: createRoot(Layout), rootRouter: RootViewRouter },
        domains: {
          root: "example.test",
          groups: [
            { subdomain: ":shop", view: { rootRouter: ShopViewRouter, translate: true } },
            { subdomain: "admin", view: { rootRouter: ShopViewRouter } },
          ],
        },
      },
    };
  },
});

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

async function visit(url: string) {
  const answer = await app.fetch(new Request(url));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  return { status: res.status, body: await res.text() };
}

describe("route.view.translate / Meta.translate (#1087)", () => {
  test("by default every page carries the notranslate tag", async () => {
    const res = await visit("http://example.test/");
    expect(res.status).toBe(200);
    expect(res.body).toContain(NOTRANSLATE);
  });

  test("Meta.translate() leaves it out of one page", async () => {
    const res = await visit("http://example.test/allows");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("notranslate");
  });

  test("a group with translate: true leaves it out of its pages", async () => {
    const res = await visit("http://acme.example.test/");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("notranslate");
  });

  test("and of its static views", async () => {
    const res = await visit("http://acme.example.test/static");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<main>page</main>");
    expect(res.body).not.toContain("notranslate");
  });

  test("and of its 404 page", async () => {
    const res = await visit("http://acme.example.test/nope");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("notranslate");
  });

  test("a handler's Meta.translate(false) wins over the group's", async () => {
    const res = await visit("http://acme.example.test/keeps");
    expect(res.body).toContain(NOTRANSLATE);
  });

  test("a group without it keeps the tag", async () => {
    const res = await visit("http://admin.example.test/");
    expect(res.body).toContain(NOTRANSLATE);
  });

  test("a client navigation carries the flag", async () => {
    const res = await visit("http://acme.example.test/.json");
    const envelope = JSON.parse(res.body.split("\n")[0]);
    expect(envelope.meta.translate).toBe(true);
  });
});
