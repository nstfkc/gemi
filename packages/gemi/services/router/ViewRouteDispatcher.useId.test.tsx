import { afterEach, describe, expect, test, vi } from "vitest";
import { act, createElement, useId, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ErrorBoundary } from "react-error-boundary";

import { App } from "../../app/App";
import { ClientRouter } from "../../client/ClientRouter";
import { createRoot } from "../../client/createRoot";
import { documentElement } from "../../client/documentTree";
import { Head } from "../../client/Head";
import type { RootLayoutProps } from "../../client/htmlAttributes";
import { Link } from "../../client/Link";
import { ServerDataProvider } from "../../client/ServerDataProvider";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

// Vitest's `import.meta.hot` has `on` but no `off`, so the dev-only reload
// listener throws on unmount. It plays no part in what is tested here.
vi.mock("../../client/HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

process.env.SECRET ??= "use-id-test-secret";

/**
 * #1200: the server put the page root after the `modulepreload` links, the
 * stylesheets and the theme script, at an index that changed with each of
 * them, while the browser hydrated it as the third of three children. `useId`
 * derives ids from that position, so every id differed: a text mismatch threw
 * a recoverable hydration error and client-rendered the page, an attribute one
 * stayed out of sync with the DOM.
 *
 * The page below is server-rendered by the real dispatcher and hydrated over
 * that HTML with the tree `init` hydrates, with ids as text and as attributes
 * in the root layout, a layout and a view.
 */

function Probe(props: { name: string }) {
  const id = useId();
  return (
    <label data-probe={props.name} htmlFor={id}>
      {id}
    </label>
  );
}

const AppLayout = (props: RootLayoutProps) => (
  <html {...props.htmlAttributes}>
    <Head />
    <body>
      <Probe name="root" />
      {props.children}
    </body>
  </html>
);

function Layout(props: { children?: ReactNode }) {
  return (
    <section>
      <Probe name="layout" />
      <Link href={"/about" as never}>About</Link>
      {props.children}
    </section>
  );
}
function Home() {
  return (
    <main data-view="Home">
      <Probe name="view" />
    </main>
  );
}
function About() {
  return (
    <main data-view="About">
      <Probe name="view" />
    </main>
  );
}
const NotFound = () => <p>not found</p>;

const views: Record<string, any> = { "404": NotFound, Layout, Home, About };

class RootApiRouter extends ApiRouter {
  routes = {};
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", {
      "/": this.view("Home"),
      "/about": this.view("About"),
      "/plain": this.view("Home").middleware(["no-theme"]),
    }),
  };
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(AppLayout), rootRouter: RootViewRouter },
    },
  };
}

const app = new App({ kernel: TestKernel });

function params(shape: { preloads: number; styles: number }) {
  return {
    getStyles: async () =>
      Array.from({ length: shape.styles }, (_, i) =>
        createElement("style", {
          key: i,
          type: "text/css",
          dangerouslySetInnerHTML: { __html: `.s${i}{color:red}` },
        }),
      ),
    viewImportMap: views,
    viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
    loaders: "{}",
    cssManifest: {},
    ogMap: {},
    clientEntry: {
      module: "/assets/client.js",
      preload: Array.from({ length: shape.preloads }, (_, i) => `/assets/chunk-${i}.js`),
    },
    modulePreloadManifest: {},
  };
}

async function serve(url: string, shape: { preloads: number; styles: number }) {
  const answer = await app.fetch(new Request(url));
  const res =
    typeof answer === "function" ? ((await (answer as any)(params(shape))) as Response) : (answer as Response);
  return res;
}

/**
 * The server render has to run without a DOM (gemi's server code tells the
 * two apart by `typeof window`), and the dispatcher can't be loaded in a
 * jsdom test environment, so the browser's globals come from a `JSDOM` of the
 * served document, installed only for hydration and navigation.
 */
let installed: string[] = [];
function installDom(dom: JSDOM) {
  const win = dom.window as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in globalThis && key !== "window" && key !== "document" && key !== "navigator") continue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: () => (key === "window" ? win : win[key]),
    });
    installed.push(key);
  }
}
function uninstallDom() {
  for (const key of installed) delete (globalThis as any)[key];
  installed = [];
}

let root: Root | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  globalThis.fetch = realFetch;
  uninstallDom();
});

const probes = () =>
  Object.fromEntries(
    [...document.querySelectorAll("[data-probe]")].map((el) => [
      el.getAttribute("data-probe"),
      { text: el.textContent, htmlFor: el.getAttribute("for") },
    ]),
  );

/** Loads the server's document for `path`, then hydrates it as `init` does. */
async function hardLoad(path: string, shape: { preloads: number; styles: number }) {
  act(() => root?.unmount());
  root = null;
  uninstallDom();
  const res = await serve(`http://localhost${path}`, shape);
  expect(res.status).toBe(200);
  const html = await res.text();

  const data = html.match(/window\.__GEMI_DATA__ = (.*?);window\.loaders=/s)?.[1];
  expect(data, "the document carries its data").toBeTruthy();

  installDom(new JSDOM(html, { url: `http://localhost${path}` }));
  (window as any).__GEMI_DATA__ = JSON.parse(data!);
  const { hydrateRoot } = await import("react-dom/client");

  const server = probes();
  const errors: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(
      document,
      documentElement(
        <ErrorBoundary fallback={<div />} onError={(e) => errors.push(e)}>
          <ServerDataProvider>
            <ClientRouter RootLayout={AppLayout} viewImportMap={views as never} />
          </ServerDataProvider>
        </ErrorBoundary>,
      ),
      {
        onRecoverableError: (e) => errors.push(e),
        onCaughtError: (e) => errors.push(e),
      },
    );
  });
  return { html, server, errors };
}

describe("useId on a hydrated page (#1200)", () => {
  test.each([
    { path: "/", preloads: 0, styles: 0 },
    { path: "/", preloads: 0, styles: 1 },
    { path: "/", preloads: 1, styles: 0 },
    { path: "/", preloads: 6, styles: 3 },
    { path: "/plain", preloads: 0, styles: 0 },
    { path: "/plain", preloads: 4, styles: 2 },
  ])("$path with $preloads preload links and $styles styles hydrates with the server's ids", async ({
    path,
    preloads,
    styles,
  }) => {
    const { html, server, errors } = await hardLoad(path, { preloads, styles });

    // The shape under test is really there.
    expect(html.match(/rel="modulepreload"/g)?.length ?? 0).toBe(preloads);
    expect(html.match(/<style/g)?.length ?? 0).toBe(styles);
    expect(html.includes('"theme":{'), "theme script").toBe(path !== "/plain");

    expect(Object.keys(server).sort()).toEqual(["layout", "root", "view"]);
    for (const probe of Object.values(server)) {
      expect(probe.text).toBeTruthy();
      expect(probe.htmlFor).toBe(probe.text);
    }

    expect(errors).toEqual([]);
    // A text mismatch is a recoverable error (caught above) and the page is
    // client-rendered with the client's ids; an attribute one is left as the
    // server wrote it. Either way the DOM now holds what both sides agreed on.
    expect(probes()).toEqual(server);
  });

  test("the ids are the same whatever the number of links and styles", async () => {
    const a = await hardLoad("/", { preloads: 0, styles: 0 });
    const b = await hardLoad("/", { preloads: 7, styles: 4 });
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(b.server).toEqual(a.server);
  });

  test("a client navigation keeps the root layout's and the layout's ids", async () => {
    const shape = { preloads: 3, styles: 2 };
    const { server, errors } = await hardLoad("/", shape);
    expect(errors).toEqual([]);

    // The router's `.json` request, answered by the same app.
    const fetched: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      fetched.push(url.pathname);
      return serve(url.href, shape);
    }) as unknown as typeof fetch;

    const anchor = document.querySelector("a")!;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await act(async () => {});

    expect(window.location.pathname).toBe("/about");
    expect(fetched.some((p) => p.startsWith("/about"))).toBe(true);
    expect(document.querySelector('[data-view="About"]')).not.toBeNull();
    expect(errors).toEqual([]);

    const after = probes();
    expect(after.root).toEqual(server.root);
    expect(after.layout).toEqual(server.layout);
    // The new view is mounted on the client: its own id, used consistently.
    expect(after.view.text).toBeTruthy();
    expect(after.view.htmlFor).toBe(after.view.text);
  });
});
