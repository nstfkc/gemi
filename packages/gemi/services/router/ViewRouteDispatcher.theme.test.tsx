import { describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { useTheme } from "../../client/ThemeProvider";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * The theme script and the server's reading of the theme cookie (#937), as a
 * full request through `app.fetch`.
 */

process.env.SECRET ??= "theme-test-secret";

// The SSR path an app takes to render the class itself: `useTheme().resolved`.
const AppLayout = (props: RootLayoutProps) => {
  const { resolved } = useTheme();
  return (
    <html {...props.htmlAttributes} data-resolved={String(resolved)}>
      <Head />
      <body>{props.children}</body>
    </html>
  );
};

const Page = (props: { text: string }) => <main>{props.text}</main>;

const views: Record<string, any> = { "404": () => <p>not found</p>, Page };

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Page", () => ({ text: "home" })),
    "/preview": this.view("Page", () => ({ text: "preview" })).middleware(["no-theme"]),
  };
}

class SiteViewRouter extends ViewRouter {
  override routes = {
    "/": this.view("Page", () => ({ text: "site" })),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(AppLayout),
        rootRouter: RootViewRouter,
        theme: { default: "system" as const, cookie: "ui-theme" },
      },
      domains: {
        root: "example.test",
        groups: [{ subdomain: ":site", view: { rootRouter: SiteViewRouter, theme: false as const } }],
      },
    },
  };
}

class DefaultKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(AppLayout), rootRouter: RootViewRouter },
    },
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

async function visit(app: App, url: string, headers: Record<string, string> = {}) {
  const answer = await app.fetch(new Request(url, { headers }));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  const body = await res.text();
  const data = body.match(/window\.__GEMI_DATA__ = (\{.*?\})(?:<\/script>|;)/s)?.[1];
  return {
    status: res.status,
    body,
    html: body.match(/<html[^>]*>/)?.[0] ?? "",
    hasScript: body.includes("prefers-color-scheme"),
    theme: data ? JSON.parse(data).theme : undefined,
  };
}

describe("theme", () => {
  const app = new App({ kernel: TestKernel });

  test("the script carries the configured cookie and default, and never clears classes wholesale", async () => {
    const res = await visit(app, "http://example.test/");
    expect(res.status).toBe(200);
    expect(res.hasScript).toBe(true);
    expect(res.body).toContain('{"cookie":"ui-theme","default":"system"}');
    expect(res.body).not.toContain("c.remove('light','dark')");
    expect(res.body).not.toContain("defaultTheme");
  });

  test("the server reads the cookie, so useTheme() renders the visitor's theme", async () => {
    const res = await visit(app, "http://example.test/", { cookie: "ui-theme=dark" });
    expect(res.theme).toEqual({ cookie: "ui-theme", default: "system", value: "dark" });
    expect(res.html).toContain('data-resolved="dark"');
  });

  test("without a cookie, system cannot be resolved on the server", async () => {
    const res = await visit(app, "http://example.test/", { cookie: "ui-theme=bogus" });
    expect(res.theme).toEqual({ cookie: "ui-theme", default: "system", value: null });
    expect(res.html).toContain('data-resolved="null"');
  });

  test('"no-theme" drops the script from that route', async () => {
    const res = await visit(app, "http://example.test/preview", { cookie: "ui-theme=dark" });
    expect(res.status).toBe(200);
    expect(res.hasScript).toBe(false);
    expect(res.theme).toBeNull();
  });

  test("theme: false drops it for a whole host group", async () => {
    const res = await visit(app, "http://acme.example.test/", { cookie: "ui-theme=dark" });
    expect(res.status).toBe(200);
    expect(res.body).toContain("site");
    expect(res.hasScript).toBe(false);
  });

  test('by default the cookie is "theme" and there is no default theme', async () => {
    const res = await visit(new App({ kernel: DefaultKernel }), "http://localhost/", {
      cookie: "theme=light",
    });
    expect(res.body).toContain('{"cookie":"theme","default":null}');
    expect(res.theme).toEqual({ cookie: "theme", default: null, value: "light" });
  });
});
