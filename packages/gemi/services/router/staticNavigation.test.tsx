import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { island } from "../../client/islands";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { ISLAND_LOADER_SOURCE } from "../../internal/islandRuntime";
import {
  STATIC_NAVIGATION_SOURCE,
  STATIC_NAVIGATION_SOURCE_HASH,
} from "../../internal/staticNavigationRuntime";
import { STATIC_NAVIGATION_CSP_HASH } from "./staticDocument";

/**
 * `.static({ navigation })` on the server (#865): the document a navigable
 * static page is sent as. The runtime itself is tested in a DOM in
 * `staticNavigation.browser.test.ts`.
 */

process.env.SECRET ??= "static-navigation-test-secret";

const NavMenu = island(
  Object.assign(
    () => Promise.resolve({ default: () => <button type="button">Menu</button> }),
    {
      gemiIsland: "app/views/site/NavMenu.tsx",
      gemiModule: { default: () => <button type="button">Menu</button> },
    },
  ) as () => Promise<{ default: () => ReactNode }>,
);

const Layout = (props: { children: ReactNode }) => (
  <html lang="en">
    <Head />
    <body>{props.children}</body>
  </html>
);

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  "site/Layout": Layout,
  "site/Page": (props: { heading: string }) => (
    <main>
      <h1>{props.heading}</h1>
      <a href="/b">b</a>
    </main>
  ),
  "site/WithMenu": () => (
    <main>
      <NavMenu />
    </main>
  ),
};

let versions = 0;

class TestViewRouter extends ViewRouter {
  routes = {
    "/plain": this.view("site/Page", () => ({ heading: "Plain" })).static({ layout: "site/Layout" }),
    "/nav": this.view("site/Page", () => {
      Meta.title("Navigable");
      return { heading: "Nav" };
    }).static({ layout: "site/Layout", navigation: true }),
    "/versioned": this.view("site/Page", (req) => {
      // Read back by `version`, which runs in the same request scope.
      req.ctx().setHeaders("x-publication", "pub-7");
      return { heading: "Versioned" };
    }).static({
      layout: "site/Layout",
      navigation: {
        version: (req) => {
          versions++;
          return `${req.ctx().headers.get("x-publication")}|"<x>"`;
        },
        prefetch: "none",
      },
    }),
    "/menu": this.view("site/WithMenu", () => ({})).static({ navigation: true }),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: {
        rootRouter: class extends ApiRouter {
          routes = {};
        },
      },
      view: { root: createRoot(Layout), rootRouter: TestViewRouter },
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
  resolveIsland: (key: string) =>
    key === "app/views/site/NavMenu.tsx"
      ? { src: "/assets/NavMenu.js", preload: ["/assets/NavMenu.js", "/assets/react-dom.js"] }
      : undefined,
  buildId: "build-1",
};

async function fetchHtml(path: string, overrides: Partial<typeof params> = {}) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(typeof render).toBe("function");
  return await ((await (render as any)({ ...params, ...overrides })) as Response).text();
}

/** The module scripts' sources. Tests run in dev, where a script starts with Vite's preamble. */
const scripts = (html: string) =>
  [...html.matchAll(/<script type="module">(.*?)<\/script>/gs)].map((m) =>
    m[1]!.replace(/^(await import\("[^"]+"\)\.catch\(\(\)=>\{\}\);)+/, ""),
  );

describe(".static({ navigation })", () => {
  test("off, the page is what it was: no script, no marker", async () => {
    const html = await fetchHtml("/plain");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("gemi-static");
  });

  test("on, a page without islands gets the runtime and its identity, but no React", async () => {
    const html = await fetchHtml("/nav");
    const head = html.match(/<head>(.*?)<\/head>/s)![1]!;

    expect(head).toContain('<meta name="gemi-static" content="site/Layout|build-1|"/>');
    expect(scripts(html)).toEqual([STATIC_NAVIGATION_SOURCE]);
    expect(html).not.toContain(`id="gemi-islands"`);
    expect(html).not.toContain('rel="modulepreload"');
    // The script is the last thing in the body, after the content it enhances.
    expect(html).toMatch(/<\/main>(<!--\/\$-->)?<script type="module">[^<]*<\/script><\/body>/);
  });

  test("version is asked per request, after the handler, and escaped into the marker", async () => {
    const before = versions;
    const html = await fetchHtml("/versioned");

    expect(versions).toBe(before + 1);
    expect(html).toContain(
      '<meta name="gemi-static" content="site/Layout|build-1|pub-7|&quot;&lt;x>&quot;" data-prefetch="none"/>',
    );
  });

  test("islands come with their table, preloads and the runtime in place of the loader", async () => {
    const html = await fetchHtml("/menu");

    expect(html).toContain('<meta name="gemi-static" content="|build-1|"/>');
    expect(html).toContain('<link rel="modulepreload" href="/assets/NavMenu.js"/>');
    expect(html).toContain('<script type="application/json" id="gemi-islands">');
    expect(scripts(html)).toEqual([STATIC_NAVIGATION_SOURCE]);
    expect(html).not.toContain(ISLAND_LOADER_SOURCE);
  });

  test("without a build id (a test's render params) the identity still has its three parts", async () => {
    const html = await fetchHtml("/nav", { buildId: undefined });
    expect(html).toContain('content="site/Layout||"');
  });
});

describe("the navigation runtime", () => {
  test("is a constant script whose hash is published for CSP", () => {
    const hash = createHash("sha256").update(STATIC_NAVIGATION_SOURCE).digest("base64");
    expect(STATIC_NAVIGATION_CSP_HASH).toBe(`'sha256-${hash}'`);
  });

  test("was regenerated from its source (bun scripts/build-static-navigation.ts)", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../internal/staticNavigation/runtime.js"),
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(STATIC_NAVIGATION_SOURCE_HASH);
  });

  test("stays within its budget: 2.5 KB gzipped, loader included", () => {
    expect(Bun.gzipSync(STATIC_NAVIGATION_SOURCE, { level: 9 }).byteLength).toBeLessThanOrEqual(2560);
  });

  test("leaves the network and the address bar only through import(, fetch and location", () => {
    // What the browser tests (and `gemi/testing`) rely on to run it in jsdom.
    expect(STATIC_NAVIGATION_SOURCE.match(/import\(/g)).toHaveLength(1);
    expect(STATIC_NAVIGATION_SOURCE).not.toMatch(/\b(window|document|i|r)\.location\b/);
    expect(STATIC_NAVIGATION_SOURCE).not.toMatch(/\.fetch\b/);
  });
});
