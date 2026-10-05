import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createContext, type ReactNode, useContext, useId } from "react";

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

/** What gemi's Vite plugin turns `island(() => import("./x"))`'s loader into. */
const viaPlugin = (key: string, mod: Record<string, unknown>) =>
  Object.assign(() => Promise.resolve(mod), { gemiIsland: key, gemiModule: mod }) as () => Promise<any>;

/** A context the page provides, which an island on a static page must not see. */
const PageContext = createContext("no page context");

const NavMenu = island(
  viaPlugin("app/views/site/NavMenu.tsx", {
    default: (props: { label: string }) => (
      <button type="button" data-context={useContext(PageContext)}>
        {props.label}
      </button>
    ),
  }),
);

const ContactForm = island(
  viaPlugin("app/views/site/forms.tsx", {
    ContactForm: (props: { endpoint: string; note: string; children?: ReactNode }) => (
      <form method="post" action={props.endpoint} aria-describedby={useId()}>
        <p>{props.note}</p>
        {props.children}
      </form>
    ),
  }),
  { export: "ContactForm", load: "visible" },
);

/** A page component used as an island's child: it needs the page's context. */
const ReadsPageContext = () => {
  const value = useContext(PageContext);
  if (value !== "page context") throw new Error("rendered outside the page's context");
  return <em data-context={value}>{value}</em>;
};

/** The same module twice under one key, the way two `island()` calls for it would be. */
const Inner = island(viaPlugin("app/views/site/Inner.tsx", { default: () => <i>inner</i> }), {
  load: "idle",
});
const Outer = island(
  viaPlugin("app/views/site/Outer.tsx", {
    default: (props: { children?: ReactNode }) => (
      <section>
        <Inner />
        {props.children}
      </section>
    ),
  }),
);

/** Not tagged by the plugin: a test (or an app) that does not run it. */
const Untagged = island(() =>
  Promise.resolve({ default: (props: { n: number }) => <b>untagged {props.n}</b> }),
);

const WithFunctionProp = island(
  viaPlugin("app/views/site/Fn.tsx", { default: () => <span>fn</span> }),
) as (props: { onClick: () => void }) => ReactNode;

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
    <PageContext value="page context">
      <main>
        <NavMenu label="Menu" />
        <NavMenu label="Menu again" />
        <ContactForm endpoint="/contact" note={props.note}>
          <strong>Static child</strong>
          <ReadsPageContext />
          <Inner />
        </ContactForm>
        <Outer />
      </main>
    </PageContext>
  ),
  "site/Untagged": () => <Untagged n={1} />,
  "site/BadProps": () => <WithFunctionProp onClick={() => {}} />,
  "site/Missing": () => <p>never rendered</p>,
  Hydrated: () => (
    <PageContext value="page context">
      <main>
        <NavMenu label="Hydrated menu" />
      </main>
    </PageContext>
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
    "/untagged": this.view("site/Untagged", () => ({})).static(),
    "/bad-props": this.view("site/BadProps", () => ({})).static(),
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
  "app/views/site/NavMenu.tsx": {
    src: "/assets/NavMenu.js",
    preload: ["/assets/NavMenu.js", "/assets/react-dom.js", "/assets/icons.js"],
  },
  "app/views/site/forms.tsx": {
    src: "/assets/forms.js",
    preload: ["/assets/forms.js", "/assets/react-dom.js"],
  },
  "app/views/site/Inner.tsx": { src: "/assets/Inner.js", preload: ["/assets/Inner.js"] },
  "app/views/site/Outer.tsx": { src: "/assets/Outer.js", preload: ["/assets/Outer.js"] },
};

const styleCalls: { views: string[]; options?: { static?: boolean; layout?: string } }[] = [];

const prodParams = {
  getStyles: async (views: string[], options?: { static?: boolean; layout?: string }) => {
    styleCalls.push({ views, options });
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
    expect(styleCalls).toEqual([
      { views: ["site/WithIslands"], options: { static: true, layout: "site/Layout" } },
    ]);
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

  test("do not answer a .json navigation, so the handler's output stays on the server", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/plain.json"));

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(404);
    expect(await (res as Response).text()).not.toContain("Hello");
  });

  test("are listed for the client router, so navigating there loads the page", async () => {
    const html = await (await fetchDocument("/hydrated")).text();
    const data = JSON.parse(html.match(/window\.__GEMI_DATA__ = (\{.*?\});window\.loaders/s)![1]);

    expect(data.staticRoutes).toEqual(["/plain", "/site", "/untagged", "/bad-props", "/missing"]);
  });
});

/** The page's island table, parsed. */
function islandTable(html: string) {
  return JSON.parse(html.match(/<script type="application\/json" id="gemi-islands">(.*?)<\/script>/)![1]);
}

/** The table index of the island built as `/assets/<name>.js`. */
const indexOf = (table: { i: { s: string }[] }, name: string) =>
  table.i.findIndex((entry) => entry.s === `/assets/${name}.js`);

/** Every marker's opening tag, in document order. */
const markers = (html: string) => html.match(/<gemi-island [^>]*>/g) ?? [];

const decodeAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe("islands in a static view", () => {
  test("server-render the component inside a marker with its props", async () => {
    const html = await (await fetchDocument("/site")).text();

    expect(html).toContain(
      '<gemi-island data-island="0" data-uid="i0-" data-props="{&quot;label&quot;:&quot;Menu&quot;}" ' +
        'style="display:contents"><button type="button" data-context="no page context">Menu</button></gemi-island>',
    );
  });

  test("render as roots of their own: no page context, and their own useId prefix", async () => {
    const html = await (await fetchDocument("/site")).text();

    // The island's own render; its children are the page's (see the slot test).
    expect(html).not.toContain('<button type="button" data-context="page context"');
    expect(html).toContain('<button type="button" data-context="no page context"');
    const form = html.match(/<form [^>]*aria-describedby="([^"]+)"/)!;
    const formIndex = indexOf(islandTable(html), "forms");
    const uid = html.match(new RegExp(`data-island="${formIndex}" data-uid="([^"]+)"`))![1];
    // React's ids are `_<prefix>R_…`: the island's prefix is in it.
    expect(form[1]).toContain(uid);
  });

  test("add the loader and a table of the island modules the page used, once each", async () => {
    const html = await (await fetchDocument("/site")).text();

    const table = islandTable(html);
    // In the order the islands rendered.
    expect(table.i).toHaveLength(4);
    expect(table.i).toEqual(
      expect.arrayContaining([
        { s: "/assets/NavMenu.js", e: "default", l: "eager" },
        { s: "/assets/forms.js", e: "ContactForm", l: "visible" },
        { s: "/assets/Inner.js", e: "default", l: "idle" },
        { s: "/assets/Outer.js", e: "default", l: "eager" },
      ]),
    );
    // Two NavMenus, one entry.
    expect(markers(html).filter((m) => m.includes(`data-island="${indexOf(table, "NavMenu")}"`))).toHaveLength(2);
    // Outside production the loader installs the React Refresh preamble first.
    expect(html.split(`${ISLAND_LOADER_SOURCE}</script>`)).toHaveLength(2);
    // Before `</body>`, after the content it hydrates.
    expect(html.indexOf('id="gemi-islands"')).toBeGreaterThan(html.indexOf("<main>"));
    expect(html.indexOf('id="gemi-islands"')).toBeLessThan(html.lastIndexOf("</body>"));
  });

  test("preload eager islands' chunks (React included) in the head, once, and lazy ones not at all", async () => {
    const html = await (await fetchDocument("/site")).text();
    const head = html.slice(0, html.indexOf("</head>"));

    expect(head.split('<link rel="modulepreload" href="/assets/react-dom.js"/>')).toHaveLength(2);
    expect(head).toContain('<link rel="modulepreload" href="/assets/NavMenu.js"/>');
    expect(head).toContain('<link rel="modulepreload" href="/assets/icons.js"/>');
    expect(html).not.toContain('modulepreload" href="/assets/forms.js"');
    expect(html).not.toContain('modulepreload" href="/assets/Inner.js"');
  });

  test("serialise props escaped, so they cannot break out of the attribute", async () => {
    const html = await (await fetchDocument("/site")).text();

    const forms = indexOf(islandTable(html), "forms");
    const attribute = html.match(
      new RegExp(`<gemi-island data-island="${forms}" data-uid="[^"]*" data-props="([^"]*)"`),
    );
    expect(attribute).not.toBeNull();
    // Nothing the attribute holds can close it or the element.
    expect(attribute![1]).not.toMatch(/[<>"]/);
    expect(JSON.parse(decodeAttribute(attribute![1]))).toEqual({
      endpoint: "/contact",
      note: `</gemi-island><script>alert("x")</script>&"'`,
    });
    // The only scripts are the two gemi put there.
    expect(html.match(/<script/g)).toHaveLength(2);
  });

  test("pass static children through as HTML in a slot, where islands are islands again", async () => {
    const html = await (await fetchDocument("/site")).text();
    const slot = html.match(/<gemi-slot style="display:contents">(.*?)<\/gemi-slot>/)![1];

    expect(slot).toContain("<strong>Static child</strong>");
    // Rendered in the page tree, so with the page's context (#805).
    expect(slot).toContain('<em data-context="page context">page context</em>');
    // Spliced: no placeholder or template left behind.
    expect(html).not.toContain("<template");
    expect(html).not.toContain("data-slot");
    // `Inner` in the children: an island of its own, with its own marker.
    const inner = indexOf(islandTable(html), "Inner");
    expect(slot).toMatch(new RegExp(`<gemi-island data-island="${inner}" [^>]*><i>inner</i></gemi-island>`));
  });

  test("an island in an island's own render is part of that root, not a marker", async () => {
    const html = await (await fetchDocument("/site")).text();
    const index = indexOf(islandTable(html), "Outer");
    const outer = html.match(new RegExp(`<gemi-island data-island="${index}" [^>]*>(.*?)</gemi-island>`))![1];

    expect(outer).toBe("<section><i>inner</i></section>");
  });

  test("props that are not plain data fail the render in dev, naming the prop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const render = await app.fetch(new Request("http://gemi.dev/bad-props"));
    const result = (async () => (render as any)(prodParams))();

    const outcome = await result.then(
      async (res: Response) => ({ status: res.status, body: await res.text() }),
      (err: Error) => ({ status: 0, body: err.message }),
    );
    expect(outcome.body).not.toContain("<span>fn</span>");
    expect(error.mock.calls.flat().map(String).join("\n") + outcome.body).toMatch(
      /island\(app\/views\/site\/Fn\.tsx\): the prop `onClick` is a function/,
    );
  });

  test("a page with no islands gets no loader even when other pages have some", async () => {
    await fetchDocument("/site");
    const html = await (await fetchDocument("/plain")).text();
    expect(html).not.toContain("gemi-islands");
  });

  test("an island with no build entry is left as static markup", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const render = await app.fetch(new Request("http://gemi.dev/site"));
    const res: Response = await (render as any)({
      ...prodParams,
      resolveIsland: () => undefined,
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<button");
    expect(html).not.toContain("<script");
    expect(error).toHaveBeenCalled();
  });

  test("without a resolver (a test's render params) the markup is the whole result, silently", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const render = await app.fetch(new Request("http://gemi.dev/site"));
    const res: Response = await (render as any)({ ...prodParams, resolveIsland: undefined });
    const html = await res.text();

    expect(html).toContain("<gemi-island");
    expect(html).not.toContain("<script");
    expect(error).not.toHaveBeenCalled();
  });

  test("render without gemi's Vite plugin, loading the component through the import", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await (await fetchDocument("/untagged")).text();

    expect(html).toMatch(/<gemi-island data-island="0" [^>]*><b>untagged <!-- -->1<\/b><\/gemi-island>/);
    // Nothing to point the browser at, so no loader; the markup stands.
    expect(html).not.toContain("<script");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no client build entry"));
  });
});

describe("islands in a hydrated view", () => {
  test("render as the plain component in place, with the page's context", async () => {
    const html = await (await fetchDocument("/hydrated")).text();

    expect(html).toContain('<button type="button" data-context="page context">Hydrated menu</button>');
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
