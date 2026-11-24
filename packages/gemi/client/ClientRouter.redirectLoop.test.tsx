/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { Link } from "./Link";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { CHUNK_RELOAD_MARKER, __resetChunkLoadRecovery } from "./chunkLoadRecovery";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A cached `.json` redirect made two routes redirect to each other. The client
 * followed every hop with `history.replaceState` until Safari threw
 * `SecurityError: history.replaceState() more than 100 times per 10 seconds`.
 */

function Layout(props: { children?: ReactNode }) {
  return (
    <section>
      <Link href={"/a" as never}>A</Link>
      {props.children}
    </section>
  );
}
const Home = () => <p data-view="Home">home</p>;
const A = () => <p data-view="A">a</p>;
const B = () => <p data-view="B">b</p>;
const NotFound = () => <p data-view="404">not found</p>;

const viewImportMap = { Layout, Home, A, B, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", {
      "/": this.view("Home"),
      "/a": this.view("A"),
      "/b": this.view("B"),
    }),
  };
}

const value = {
  routeManifest: createRouteManifest({ "/": AppRouter }),
  pageData: { "/": { Layout: {}, Home: {} } },
  breadcrumbs: {},
  prefetchedData: {},
  router: {
    pathname: "/",
    params: {},
    currentPath: "/",
    is404: false,
    searchParams: "",
    urlLocaleSegment: null,
    domain: null,
  },
  i18n: {
    dictionary: {},
    currentLocale: "en-US",
    supportedLocales: ["en-US"],
    defaultLocale: "en-US",
  },
  componentTree: [["404", []], ...createComponentTree({ "/": AppRouter })],
  auth: { user: null },
  features: {},
  __csrf: "",
  cssManifest: {},
  modulePreloadManifest: {},
  meta: {},
  appId: "test",
} as unknown as ServerDataContextValue;

const json = (body: Record<string, unknown>) =>
  new Response(JSON.stringify({ breadcrumbs: {}, prefetchedData: {}, meta: {}, i18n: value.i18n, ...body }), {
    status: 200,
  });
const redirectTo = (path: string) => json({ data: {}, directive: { kind: "Redirect", path } });
const page = (route: string, view: string) => json({ data: { [route]: { Layout: {}, [view]: {} } } });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const realFetch = globalThis.fetch;
const realLocation = window.location;
let assign: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let fetched: string[];

function serve(routes: Record<string, () => Response>) {
  fetched = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), realLocation.origin).pathname;
    fetched.push(path);
    return routes[path]?.() ?? new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  __resetChunkLoadRecovery();
  assign = vi.fn();
  reload = vi.fn();
  const location = { assign, reload, toString: () => realLocation.href };
  for (const key of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
    Object.defineProperty(location, key, { get: () => (realLocation as any)[key] });
  }
  Object.defineProperty(window, "location", { configurable: true, value: location });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  vi.restoreAllMocks();
});

const text = (view: string) =>
  container!.querySelector(`[data-view="${view}"]`)?.textContent ?? null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <ServerDataContext.Provider value={value}>
        <ClientRouter viewImportMap={viewImportMap} RootLayout={(p: any) => <>{p.children}</>} />
      </ServerDataContext.Provider>,
    );
  });
}

async function clickA() {
  await act(async () => {
    container!
      .querySelector(`a[href="/a"]`)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  // Enough turns for a loop to have spun many times over if nothing stopped it.
  for (let i = 0; i < 20; i++) await act(async () => {});
}

describe("client-side redirects", () => {
  test("a single redirect is followed", async () => {
    serve({ "/a.json": () => redirectTo("/b"), "/b.json": () => page("/b", "B") });
    await mount();
    const replaceState = vi.spyOn(window.history, "replaceState");

    await clickA();

    expect(realLocation.pathname).toBe("/b");
    expect(text("B")).toBe("b");
    expect(fetched).toEqual(["/a.json", "/b.json"]);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("two routes redirecting to each other stop after one bounce and load the page in full", async () => {
    serve({ "/a.json": () => redirectTo("/b"), "/b.json": () => redirectTo("/a") });
    await mount();
    const replaceState = vi.spyOn(window.history, "replaceState");

    await clickA();

    // A -> B followed; B -> A is the loop: no second `replaceState`.
    expect(fetched).toEqual(["/a.json", "/b.json"]);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`${realLocation.origin}/a`);
    // The page on screen stays until the full load replaces it.
    expect(text("Home")).toBe("home");
  });

  test("inside the cooldown the loop stops without another full load", async () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ [`${realLocation.origin}/a`]: Date.now() }),
    );
    serve({ "/a.json": () => redirectTo("/b"), "/b.json": () => redirectTo("/a") });
    await mount();

    await clickA();

    expect(fetched).toEqual(["/a.json", "/b.json"]);
    expect(assign).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(text("Home")).toBe("home");
  });

  test("a long chain of distinct redirects is cut off", async () => {
    let hop = 0;
    serve({
      "/a.json": () => redirectTo(`/a?hop=${++hop}`),
    });
    await mount();
    const replaceState = vi.spyOn(window.history, "replaceState");

    await clickA();

    expect(fetched.length).toBeLessThanOrEqual(10);
    expect(replaceState.mock.calls.length).toBeLessThanOrEqual(10);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  test("a later, unrelated navigation starts a new chain", async () => {
    serve({ "/a.json": () => redirectTo("/b"), "/b.json": () => page("/b", "B") });
    await mount();

    await clickA();
    expect(text("B")).toBe("b");
    await clickA();

    expect(fetched).toEqual(["/a.json", "/b.json", "/a.json", "/b.json"]);
    expect(text("B")).toBe("b");
    expect(assign).not.toHaveBeenCalled();
  });
});
