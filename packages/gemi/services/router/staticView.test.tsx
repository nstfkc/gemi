import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { island } from "../../client/islands";
import { Link } from "../../client/Link";
import { Meta } from "../../facades/Meta";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { RecordNotFoundError } from "../../orm/errors";
import { ISLAND_LOADER_CSP_HASH, ISLAND_LOADER_SOURCE } from "./staticDocument";
import { createHash } from "node:crypto";

/**
 * `.static()` views and islands (#790): full requests through `app.fetch`, as
 * the servers make them, because what matters is the bytes a visitor gets.
 */

process.env.SECRET ??= "static-view-test-secret";

/** What gemi's Vite plugin turns `() => import("./x.island")` into. */
const islandLoader = (key: string) =>
  Object.assign(() => Promise.reject(new Error("not in tests")), { gemiIsland: key }) as any;

const NavMenu = island(
  "nav-menu",
  (props: { label: string }) => <button type="button">{props.label}</button>,
  islandLoader("app/views/site/navMenu.island.ts"),
);

const ContactForm = island(
  "contact-form",
  (props: { endpoint: string; note: string }) => (
    <form method="post" action={props.endpoint}>
      <p>{props.note}</p>
    </form>
  ),
  islandLoader("app/views/site/form.island.ts"),
  { props: true, load: "visible" },
);

const AppLayout = (props: { children: ReactNode; locale: string }) => (
  <html lang={props.locale}>
    <Head />
    <body data-layout="app">{props.children}</body>
  </html>
);

const SiteLayout = (props: { children: ReactNode; locale: string }) => (
  <html lang={props.locale}>
    <Head />
    <body data-layout="site">{props.children}</body>
  </html>
);

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  "site/Layout": SiteLayout,
  "site/Plain": (props: { heading: string }) => (
    <main>
      <h1>{props.heading}</h1>
      <Link href="/elsewhere">elsewhere</Link>
    </main>
  ),
  "site/WithIslands": (props: { note: string }) => (
    <main>
      <NavMenu label="Menu" />
      <NavMenu label="Menu again" />
      <ContactForm endpoint="/contact" note={props.note} />
    </main>
  ),
  "site/Missing": () => <p>never rendered</p>,
  Hydrated: () => (
    <main>
      <NavMenu label="Hydrated menu" />
    </main>
  ),
};

class TestApiRouter extends ApiRouter {
  routes = {};
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/plain": this.view("site/Plain", () => {
      Meta.title("A static page");
      Meta.description("Rendered once, shipped without React");
      return { heading: "Hello" };
    }).static(),
    "/site": this.view("site/WithIslands", () => ({
      note: `</gemi-island><script>alert("x")</script>&"'`,
    })).static({ layout: "site/Layout" }),
    // Its own view: two routes sharing one is #788, a separate bug.
    "/missing": this.view("site/Missing", () => {
      throw new RecordNotFoundError("Page", "findUniqueOrThrow");
    }).static(),
    "/hydrated": this.view("Hydrated", () => ({})),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: TestApiRouter },
      view: {
        root: createRoot(AppLayout),
        rootRouter: TestViewRouter,
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

const islandAssets: Record<string, { src: string; preload: string[] }> = {
  "app/views/site/navMenu.island.ts": {
    src: "/assets/navMenu.island-abc.js",
    preload: ["/assets/navMenu.island-abc.js", "/assets/dom-util.js"],
  },
  "app/views/site/form.island.ts": {
    src: "/assets/form.island-def.js",
    preload: ["/assets/form.island-def.js"],
  },
};

const styleCalls: { views: string[]; layout?: string }[] = [];

const prodParams = {
  getStyles: async (views: string[], options?: { layout?: string }) => {
    styleCalls.push({ views, layout: options?.layout });
    return [];
  },
  viewImportMap: views,
  viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
  clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js"] },
  modulePreloadManifest: { "site/Plain": ["/assets/Plain.js"], Hydrated: ["/assets/Hydrated.js"] },
  resolveIsland: (key: string) => islandAssets[key],
};

async function fetchDocument(path: string) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(typeof render).toBe("function");
  return (await (render as any)(prodParams)) as Response;
}

beforeEach(() => {
  styleCalls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("static views", () => {
  test("ship no client runtime when the page has no islands", async () => {
    const res = await fetchDocument("/plain");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("__GEMI_DATA__");
    expect(html).not.toContain("modulepreload");
    expect(html).not.toContain("window.loaders");
    // React's streaming machinery: reveal functions and deferred segments.
    expect(html).not.toMatch(/\$RC|\$RS|<template/);
  });

  test("keep Head metadata, the app layout and plain links", async () => {
    const html = await (await fetchDocument("/plain")).text();

    expect(html).toContain("<title>A static page</title>");
    expect(html).toContain('content="Rendered once, shipped without React"');
    expect(html).toContain('data-layout="app"');
    expect(html).toMatch(/<a [^>]*href="\/elsewhere"/);
  });

  test("render with their own layout and ask for its styles instead of the app's", async () => {
    const html = await (await fetchDocument("/site")).text();

    expect(html).toContain('data-layout="site"');
    expect(html).not.toContain('data-layout="app"');
    expect(styleCalls).toEqual([{ views: ["site/WithIslands"], layout: "site/Layout" }]);
  });

  test("are one body for every visitor, so they do not vary on User-Agent", async () => {
    const res = await fetchDocument("/plain");
    expect(res.headers.get("Vary") ?? "").not.toContain("User-Agent");
  });

  test("a missing record still renders the app's 404, hydrated as usual", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetchDocument("/missing");
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(html).toContain("__GEMI_DATA__");
  });

  test("are listed for the client router, so navigating there loads the page", async () => {
    const html = await (await fetchDocument("/hydrated")).text();
    const data = JSON.parse(html.match(/window\.__GEMI_DATA__ = (\{.*?\});window\.loaders/s)![1]);

    expect(data.staticRoutes).toEqual(["/plain", "/site", "/missing"]);
  });
});

describe("islands in a static view", () => {
  test("render their markup inside a marker", async () => {
    const html = await (await fetchDocument("/site")).text();

    expect(html).toContain(
      '<gemi-island name="nav-menu" style="display:contents"><button type="button">Menu</button></gemi-island>',
    );
  });

  test("add the loader and a table of the islands the page used, once each", async () => {
    const html = await (await fetchDocument("/site")).text();

    const table = JSON.parse(
      html.match(/<script type="application\/json" id="gemi-islands">(.*?)<\/script>/)![1],
    );
    expect(table).toEqual({
      "nav-menu": { src: "/assets/navMenu.island-abc.js", load: "eager" },
      "contact-form": { src: "/assets/form.island-def.js", load: "visible" },
    });
    // Outside production the loader installs the React Refresh preamble first.
    expect(html.split(`${ISLAND_LOADER_SOURCE}</script>`)).toHaveLength(2);
    // Before `</body>`, after the content it mounts.
    expect(html.indexOf("gemi-islands")).toBeGreaterThan(html.indexOf("<main>"));
    expect(html.indexOf('id="gemi-islands"')).toBeLessThan(html.lastIndexOf("</body>"));
  });

  test("preload eager islands' chunks in the head, and lazy ones not at all", async () => {
    const html = await (await fetchDocument("/site")).text();
    const head = html.slice(0, html.indexOf("</head>"));

    expect(head).toContain('<link rel="modulepreload" href="/assets/navMenu.island-abc.js"/>');
    expect(head).toContain('<link rel="modulepreload" href="/assets/dom-util.js"/>');
    expect(html).not.toContain('modulepreload" href="/assets/form.island-def.js"');
  });

  test("serialise props only when asked, escaped so they cannot break out", async () => {
    const html = await (await fetchDocument("/site")).text();

    const marker = html.match(/<gemi-island name="contact-form" data-props="([^"]*)"/);
    expect(marker).not.toBeNull();
    // Nothing the attribute holds can close it or the element.
    expect(marker![1]).not.toMatch(/[<>"]/);
    const decoded = marker![1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&");
    expect(JSON.parse(decoded)).toEqual({
      endpoint: "/contact",
      note: `</gemi-island><script>alert("x")</script>&"'`,
    });
    // The only scripts are the two gemi put there.
    expect(html.match(/<script/g)).toHaveLength(2);
    // The nav menu did not opt into props.
    expect(html).not.toMatch(/name="nav-menu" data-props/);
  });

  test("a page with no islands gets no loader even when other pages have some", async () => {
    await fetchDocument("/site");
    const html = await (await fetchDocument("/plain")).text();
    expect(html).not.toContain("gemi-islands");
  });

  test("an island with no build entry is left as static markup", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const render = await app.fetch(new Request("http://gemi.dev/site"));
    const res: Response = await (render as any)({ ...prodParams, resolveIsland: () => undefined });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<button");
    expect(html).not.toContain("<script");
    expect(error).toHaveBeenCalled();
  });
});

describe("islands in a hydrated view", () => {
  test("render as the plain component, with no marker and no loader", async () => {
    const html = await (await fetchDocument("/hydrated")).text();

    expect(html).toContain('<button type="button">Hydrated menu</button>');
    expect(html).not.toContain("<gemi-island");
    expect(html).not.toContain("gemi-islands");
  });
});

describe("the island loader", () => {
  test("is a constant script whose hash is published for CSP", () => {
    const hash = createHash("sha256").update(ISLAND_LOADER_SOURCE).digest("base64");
    expect(ISLAND_LOADER_CSP_HASH).toBe(`'sha256-${hash}'`);
  });

  test("stays under 1 KB gzipped", () => {
    expect(Bun.gzipSync(ISLAND_LOADER_SOURCE).byteLength).toBeLessThan(1024);
  });
});
