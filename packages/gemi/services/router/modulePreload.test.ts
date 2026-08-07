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
const modulePreloadManifest = {
  Home: ["/assets/Home.js", "/assets/shared-react.js"],
  AppLayout: ["/assets/AppLayout.js", "/assets/nav.js", "/assets/shared-react.js"],
  Dashboard: ["/assets/Dashboard.js", "/assets/chart.js", "/assets/shared-react.js"],
};

const prodParams = {
  getStyles: async () => [],
  viewImportMap: {},
  viewModules: {},
  bootstrapModules: ["/assets/client-entry.js"],
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
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

  test("leaves out views the current route does not render", async () => {
    const html = await fetchDocument("/app");

    expect(html).not.toContain("/assets/Home.js");
  });

  test("announces a chunk both views share once", async () => {
    const html = await fetchDocument("/app");

    expect(html.split(preloadTag("/assets/shared-react.js"))).toHaveLength(2);
  });

  test("hints land before the bootstrap script that consumes them", async () => {
    const html = await fetchDocument("/app");

    expect(html.indexOf(preloadTag("/assets/Dashboard.js"))).toBeLessThan(
      html.indexOf("window.__GEMI_DATA__"),
    );
  });

  test("announces nothing when the server has no chunk graph (dev)", async () => {
    const html = await fetchDocument("/app", {
      getStyles: async () => [],
      viewImportMap: {},
      viewModules: {},
      bootstrapModules: ["/app/client.tsx"],
      loaders: "{}",
      cssManifest: {},
      ogMap: {},
    });

    // Vite serves unbundled source in dev, so there is nothing to announce.
    expect(html).not.toContain("/assets/");
  });
});
