import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement, Suspense, type ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { useCspNonce } from "../../client/cspNonce";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { useQuery } from "../../client/useQuery";
import { Query } from "../../facades/Prefetch";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import { cspNonce } from "../../http/cspNonce";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { strictCspPolicy } from "./contentSecurityPolicy";

/**
 * CSP nonces for the inline scripts gemi renders (#1195), through the real
 * dispatcher: every inline script and style of a hydrated page carries the
 * request's nonce, streamed query payloads and React's reveal scripts
 * included; the nonce is fresh per request and the one `cspNonce()` gives the
 * app; `csp: true` sends the strict policy; a static view is allowed by hash.
 */

process.env.SECRET ??= "csp-nonce-test-secret";

const SLOW_MS = 40;

class RootApiRouter extends ApiRouter {
  routes = {
    "/slow": this.get(async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      return { rows: [1, 2, 3] };
    }),
  };
}

/** Puts the request's nonce in the response, as an app's CSP middleware would. */
class EchoNonce extends Middleware {
  run() {
    this.req.ctx().setHeaders("X-Global-Nonce", cspNonce());
  }
}

class OwnPolicy extends Middleware {
  run() {
    this.req.ctx().setHeaders("Content-Security-Policy", `script-src 'nonce-${this.req.cspNonce()}'`);
  }
}

function Slow() {
  const { data } = useQuery("/slow" as never);
  return <p data-slow="">{JSON.stringify(data)}</p>;
}

function Home() {
  return (
    <main>
      <Suspense fallback={<p>loading</p>}>
        <Slow />
      </Suspense>
    </main>
  );
}

function Plain() {
  return <main>plain</main>;
}

function AppInlineScript() {
  const nonce = useCspNonce();
  return <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: "window.app=1" }} />;
}

const Layout = (props: RootLayoutProps & { children?: ReactNode }) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>
      <AppInlineScript />
      {props.children}
    </body>
  </html>
);

const views: Record<string, any> = { "404": Plain, Home, Plain };

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => {
      (Query as any).prefetch("/slow");
      Meta.fonts([{ family: "Inter", src: "/inter.woff2" }]);
      return {};
    }),
    "/public": this.view("Plain"),
    "/own-policy": this.view("Plain").middleware(["own-policy"]),
    "/static": this.view("Plain").static({ navigation: true, cacheControl: "public, max-age=60" }),
    "/static-nonced": this.view("Plain", () => {
      cspNonce();
      return {};
    }).static({ cacheControl: "public, max-age=60" }),
  };
}

function kernel(view: Record<string, unknown>, global = ["echo-nonce"]) {
  return class extends Kernel {
    config = {
      middleware: {
        aliases: { "echo-nonce": EchoNonce, "own-policy": OwnPolicy },
        global,
      },
      route: {
        api: { rootRouter: RootApiRouter },
        view: { root: createRoot(Layout), rootRouter: RootViewRouter, ...view },
      },
    };
  };
}

const plainApp = new App({ kernel: kernel({}) });
const strictApp = new App({ kernel: kernel({ csp: true }) });
// No global middleware asking for the nonce, as on a static page meant for a CDN.
const strictStaticApp = new App({ kernel: kernel({ csp: true }, []) });
const reportOnlyApp = new App({
  kernel: kernel({ csp: { reportOnly: true, reportUri: "/csp-reports" } }),
});

const params = {
  getStyles: async () => [
    createElement("style", { key: 0, type: "text/css", dangerouslySetInnerHTML: { __html: "p{color:red}" } }),
  ],
  viewImportMap: views,
  viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
  clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js", "/assets/react.js"] },
  modulePreloadManifest: {},
};

async function load(app: App, path: string, init?: RequestInit) {
  const answer = await app.fetch(new Request(`http://localhost${path}`, init));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params)) as Response) : (answer as Response);
  return { res, html: await res.text() };
}

/** Every `<script>`, `<style>` and module preload start tag in `html`. */
function inlineTags(html: string) {
  return {
    scripts: [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]),
    styles: [...html.matchAll(/<style\b[^>]*>/g)].map((m) => m[0]),
    preloads: [...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*>/g)].map((m) => m[0]),
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("CSP nonces on a hydrated page (#1195)", () => {
  test("every inline script and style carries the request's nonce, streamed ones included", async () => {
    const { res, html } = await load(plainApp, "/");
    expect(res.status).toBe(200);
    const nonce = res.headers.get("X-Global-Nonce")!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);

    // What is under test is really there: the page data, the theme script,
    // a streamed query payload and React's reveal script for its boundary,
    // the app's own script, the fonts' style and the app stylesheet.
    expect(html).toContain("window.__GEMI_DATA__");
    expect(html).toContain('"theme":{');
    expect(html).toContain("self.__GEMI_STREAM__");
    expect(html).toMatch(/\$RC|\$RV|\$RS/);
    expect(html).toContain("window.app=1");
    expect(html).toContain("@font-face");

    const { scripts, styles, preloads } = inlineTags(html);
    expect(scripts.length).toBeGreaterThanOrEqual(5);
    expect(styles.length).toBe(2);
    expect(preloads.length).toBeGreaterThan(0);
    for (const tag of [...scripts, ...styles, ...preloads]) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  test("the nonce differs per request", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { res, html } = await load(plainApp, "/public");
      const nonce = res.headers.get("X-Global-Nonce")!;
      expect(html).toContain(`nonce="${nonce}"`);
      seen.add(nonce);
    }
    expect(seen.size).toBe(5);
  });

  test("without csp, gemi sends no policy of its own", async () => {
    const { res } = await load(plainApp, "/public");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("csp: true sends the strict policy with the page's nonce", async () => {
    const { res, html } = await load(strictApp, "/public");
    const nonce = res.headers.get("X-Global-Nonce")!;
    expect(res.headers.get("Content-Security-Policy")).toBe(
      `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'self'`,
    );
    expect(html).toContain(`nonce="${nonce}"`);
  });

  test("reportOnly and reportUri", async () => {
    const { res } = await load(reportOnlyApp, "/public");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toMatch(
      /^script-src 'nonce-[^']+' 'strict-dynamic'; object-src 'none'; base-uri 'self'; report-uri \/csp-reports$/,
    );
  });

  test("a policy the app set itself wins", async () => {
    const { res } = await load(strictApp, "/own-policy");
    const nonce = res.headers.get("X-Global-Nonce")!;
    expect(res.headers.get("Content-Security-Policy")).toBe(`script-src 'nonce-${nonce}'`);
  });

  test("a global middleware that asks for the nonce makes a static page private", async () => {
    const { res } = await load(strictApp, "/static");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    // Its policy allows the nonce the app's header was built with.
    expect(res.headers.get("Content-Security-Policy")).toContain(
      `'nonce-${res.headers.get("X-Global-Nonce")}'`,
    );
  });

  test("a nonced page is never left to a shared cache", async () => {
    const { res } = await load(plainApp, "/public");
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/public|s-maxage/);
  });
});

describe("static views (#1195)", () => {
  test("carry no nonce and are allowed by the hashes of gemi's inline scripts, staying cacheable", async () => {
    const { res, html } = await load(strictStaticApp, "/static");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(html).not.toContain("nonce=");

    const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(inline).toHaveLength(1);
    const hash = `'sha256-${createHash("sha256").update(inline[0]).digest("base64")}'`;
    expect(res.headers.get("Content-Security-Policy")).toBe(
      strictCspPolicy({ hashes: [hash] }),
    );
  });

  test("one whose request asked for a nonce is lowered to private caching", async () => {
    const { res } = await load(strictStaticApp, "/static-nonced");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });
});
