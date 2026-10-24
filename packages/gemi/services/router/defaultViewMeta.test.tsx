import { describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * The app-wide default title and metadata, `route.view.meta` (#1042).
 */

process.env.SECRET ??= "default-view-meta-test-secret";

const Layout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>{props.children}</body>
  </html>
);

const Page = () => <main>page</main>;
const views: Record<string, any> = { "404": () => <p>not found</p>, Page };

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Page"),
    "/empty-handler": this.view("Page", () => ({})),
    "/titled": this.view("Page", () => {
      Meta.title("Own title");
      return {};
    }),
    "/full": this.view("Page", () => {
      Meta.title("Full title");
      Meta.description("Full description");
      Meta.openGraph({ title: "Full og", type: "article", url: "https://example.test/full" });
      return {};
    }),
  };
}

class SiteViewRouter extends ViewRouter {
  override routes = {
    "/": this.view("Page"),
  };
}

const defaults = {
  title: "Acme",
  description: "Acme does things",
  openGraph: { image: "https://cdn.example.test/og.jpg" },
};

function kernel(view: Record<string, any>, groups: any[] = []) {
  return class extends Kernel {
    config = {
      route: {
        api: { rootRouter: RootApiRouter },
        view: { root: createRoot(Layout), rootRouter: RootViewRouter, ...view },
        ...(groups.length ? { domains: { root: "example.test", groups } } : {}),
      },
    };
  };
}

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

async function visit(app: App, url: string) {
  const answer = await app.fetch(new Request(url));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  const body = await res.text();
  return {
    status: res.status,
    body,
    title: body.match(/<title>([^<]*)<\/title>/)?.[1] ?? null,
    description: body.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? null,
    og: (property: string) =>
      body.match(new RegExp(`<meta property="og:${property}" content="([^"]*)"`))?.[1] ?? null,
  };
}

describe("route.view.meta (#1042)", () => {
  const app = new App({ kernel: kernel({ meta: defaults }) });

  test.each(["/", "/empty-handler"])("%s: a view that sets no metadata gets the default", async (path) => {
    const res = await visit(app, `http://localhost${path}`);
    expect(res.status).toBe(200);
    expect(res.title).toBe("Acme");
    expect(res.description).toBe("Acme does things");
    expect(res.og("title")).toBe("Acme");
    expect(res.og("description")).toBe("Acme does things");
    expect(res.og("type")).toBe("website");
    expect(res.og("image")).toBe("https://cdn.example.test/og.jpg");
    expect(res.body).not.toContain('property="og:url"');
  });

  test("a handler's Meta.title wins; the other fields still come from the default", async () => {
    const res = await visit(app, "http://localhost/titled");
    expect(res.title).toBe("Own title");
    expect(res.description).toBe("Acme does things");
    // The default Open Graph tags follow the page's own title.
    expect(res.og("title")).toBe("Own title");
    expect(res.og("image")).toBe("https://cdn.example.test/og.jpg");
  });

  test("a handler that sets every field keeps all of them", async () => {
    const res = await visit(app, "http://localhost/full");
    expect(res.title).toBe("Full title");
    expect(res.description).toBe("Full description");
    expect(res.og("title")).toBe("Full og");
    expect(res.og("type")).toBe("article");
    expect(res.og("url")).toBe("https://example.test/full");
    expect(res.og("image")).toBeNull();
  });

  test("the 404 view falls back to the default when onNotFound sets nothing", async () => {
    const res = await visit(app, "http://localhost/nope");
    expect(res.status).toBe(404);
    expect(res.title).toBe("Acme");
  });

  test("onNotFound's title wins over the default", async () => {
    const withHook = new App({
      kernel: kernel({ meta: defaults, onNotFound: () => Meta.title("Not here") }),
    });
    const res = await visit(withHook, "http://localhost/nope");
    expect(res.title).toBe("Not here");
    expect(res.description).toBe("Acme does things");
  });

  test("a client navigation carries the default", async () => {
    const res = await visit(app, "http://localhost/empty-handler.json");
    const envelope = JSON.parse(res.body.split("\n")[0]);
    expect(envelope.meta.title).toBe("Acme");
    expect(envelope.meta.description).toBe("Acme does things");
  });

  test("a function default runs per request, with the request", async () => {
    const seen: string[] = [];
    const fnApp = new App({
      kernel: kernel({
        meta: async (req: HttpRequest) => {
          const { pathname } = new URL(req.rawRequest.url);
          seen.push(pathname);
          return { title: `Acme ${pathname}` };
        },
      }),
    });
    expect((await visit(fnApp, "http://localhost/")).title).toBe("Acme /");
    expect((await visit(fnApp, "http://localhost/titled")).title).toBe("Own title");
    // Not called at all when the handler set every field.
    await visit(fnApp, "http://localhost/full");
    expect(seen).toEqual(["/", "/titled"]);
  });

  test("without a default, a view keeps gemi's title and no description", async () => {
    const plain = new App({ kernel: kernel({}) });
    const res = await visit(plain, "http://localhost/");
    expect(res.title).toBe("Gemi App");
    expect(res.description).toBeNull();
    expect(res.body).not.toContain("og:");
  });

  describe("route.domains", () => {
    const domainApp = new App({
      kernel: kernel({ meta: defaults }, [
        { subdomain: "inherits", view: { rootRouter: SiteViewRouter } },
        { subdomain: "own", view: { rootRouter: SiteViewRouter, meta: { title: "Own site" } } },
      ]),
    });

    test("a group inherits the root default", async () => {
      const res = await visit(domainApp, "http://inherits.example.test/");
      expect(res.title).toBe("Acme");
      expect(res.description).toBe("Acme does things");
    });

    test("a group can set its own, replacing the root default", async () => {
      const res = await visit(domainApp, "http://own.example.test/");
      expect(res.title).toBe("Own site");
      expect(res.description).toBeNull();
    });

    test("the root host keeps the root default", async () => {
      expect((await visit(domainApp, "http://example.test/")).title).toBe("Acme");
    });
  });
});
