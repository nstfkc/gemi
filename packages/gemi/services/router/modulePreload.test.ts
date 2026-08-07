import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * The shell's `modulepreload` hints (#352). Full requests through
 * `app.fetch`, because what matters is the bytes the browser receives: which
 * chunks are announced in the head, and whether hydration's entry is
 * announced there at all.
 */

process.env.SECRET ??= "module-preload-test-secret";

class TestApiRouter extends ApiRouter {
  routes = {};
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({ Home: {} })),
    "/app": this.layout("AppLayout", () => ({ AppLayout: {} }), {
      "/": this.view("Dashboard", () => ({ Dashboard: {} })),
    }),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: TestApiRouter },
      view: {
        root: () => createElement("div", null, "root"),
        rootRouter: TestViewRouter,
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

/** What `httpProd` derives from the built client manifest. */
const clientEntry = {
  module: "/assets/client-entry.js",
  preload: ["/assets/client-entry.js", "/assets/shared-react.js"],
};

const modulePreloadManifest = {
  "404": ["/assets/NotFound.js", "/assets/shared-react.js"],
  Home: ["/assets/Home.js", "/assets/shared-react.js"],
  AppLayout: ["/assets/AppLayout.js", "/assets/nav.js", "/assets/shared-react.js"],
  Dashboard: ["/assets/Dashboard.js", "/assets/chart.js", "/assets/shared-react.js"],
};

const prodParams = {
  getStyles: async () => [],
  viewImportMap: {},
  viewModules: {},
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
  clientEntry,
  modulePreloadManifest,
};

async function fetchDocument(path: string, params: Record<string, any> = prodParams) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(typeof render).toBe("function");
  const res: Response = await (render as any)(params);
  return await res.text();
}

const preloadTag = (href: string) => `<link rel="modulepreload" href="${href}"/>`;

describe("route module preloads", () => {
  test("announces every chunk the current route's views will import", async () => {
    const html = await fetchDocument("/app");

    for (const href of [
      "/assets/AppLayout.js",
      "/assets/nav.js",
      "/assets/Dashboard.js",
      "/assets/chart.js",
    ]) {
      expect(html).toContain(preloadTag(href));
    }
  });

  test("announces the client entry's own chunks", async () => {
    const html = await fetchDocument("/app");

    expect(html).toContain(preloadTag("/assets/client-entry.js"));
    expect(html).toContain(preloadTag("/assets/shared-react.js"));
  });

  test("leaves out views the current route does not render", async () => {
    const html = await fetchDocument("/app");

    // On the tag, not the raw string: the payload carries every view's list
    // for client-side navigation, so `/assets/Home.js` legitimately appears
    // there. What must not appear is a hint to fetch it now.
    expect(html).not.toContain(preloadTag("/assets/Home.js"));
  });

  test("announces a chunk the entry and both views share once", async () => {
    const html = await fetchDocument("/app");

    expect(html.split(preloadTag("/assets/shared-react.js"))).toHaveLength(2);
  });

  test("hints land before the bootstrap script that consumes them", async () => {
    const html = await fetchDocument("/app");

    expect(html.indexOf(preloadTag("/assets/Dashboard.js"))).toBeLessThan(
      html.indexOf("window.__GEMI_DATA__"),
    );
  });

  test("falls back to the 404 view's chunks on an unmatched route", async () => {
    const html = await fetchDocument("/no-such-page");

    // Nothing matched, so there is no `currentViews` — but the document is
    // still rendered, from the `404` view, and hydrating it walks the same
    // serial chain every other route was just spared.
    expect(html).toContain(preloadTag("/assets/NotFound.js"));
    expect(html).not.toContain(preloadTag("/assets/Dashboard.js"));
  });

  test("renders the .og 404 instead of throwing on an unmatched route", async () => {
    const render = await app.fetch(new Request("http://gemi.dev/no-such-page.og"));
    const res: Response =
      render instanceof Response ? render : await (render as any)(prodParams);

    // `currentViews` is undefined here; iterating it unguarded surfaced as a
    // 500 carrying a raw stack trace to whatever crawler asked.
    expect(res.status).toBe(404);
  });

  test("boots the entry from the bootstrap script, not a React bootstrap module", async () => {
    const html = await fetchDocument("/app");

    // React would preload its own `bootstrapModules` at `fetchPriority="low"`,
    // which is the whole reason the entry is imported here instead.
    expect(html).toContain(`import("/assets/client-entry.js")`);
    expect(html).not.toContain(`fetchPriority="low"`);
    expect(html).not.toContain(`<script type="module"`);
  });

  test("reports a failed entry import where window.onerror can see it", async () => {
    const html = await fetchDocument("/app");

    // A bare `import()` would surface a chunk that 404s after a deploy as an
    // `unhandledrejection` only, leaving the page unhydrated and unreported.
    expect(html).toContain(
      `import("/assets/client-entry.js").catch(function(e){setTimeout(function(){throw e})})`,
    );
  });

  test("ignores bootstrapModules when the server also offers a client entry", async () => {
    const html = await fetchDocument("/app", {
      ...prodParams,
      bootstrapModules: ["/assets/client-entry.js"],
    });

    // Honouring both would boot the entry twice *and* hand React back the
    // low-priority preload this whole change exists to avoid — which is what
    // makes the negative assertions in the test above mean anything: with a
    // `bootstrapModules` in the params, React emits both strings unless the
    // dispatcher deliberately withholds them.
    expect(html).toContain(`import("/assets/client-entry.js")`);
    expect(html).not.toContain(`fetchPriority="low"`);
    expect(html).not.toContain(`<script type="module"`);
  });

  test("still boots through bootstrapModules when the server passes them (dev)", async () => {
    const html = await fetchDocument("/app", {
      getStyles: async () => [],
      viewImportMap: {},
      viewModules: {},
      bootstrapModules: ["/app/client.tsx"],
      // What `httpDev` actually inlines — every dev shell carries `import(`
      // in its loaders, so the claim below has to name the entry specifically.
      loaders: `{"AppLayout": () => import("/app/views/AppLayout.tsx")}`,
      cssManifest: {},
      ogMap: {},
    });

    // Vite serves unbundled source in dev, so there is no chunk graph to
    // announce — React's own bootstrap handling is left alone.
    expect(html).toContain(`<script type="module" src="/app/client.tsx"`);
    expect(html).not.toContain("/assets/");
    expect(html).not.toContain(`import("/app/client.tsx")`);
  });

  test("ships the per-view chunk lists for client-side navigation", async () => {
    const html = await fetchDocument("/app");

    // Navigation walks the same chain the shell head just flattened, so it
    // needs the same data — carried in the payload like `cssManifest`.
    expect(html).toContain(`"modulePreloadManifest":`);
    expect(html).toContain(`"/assets/Home.js"`);
  });
});
