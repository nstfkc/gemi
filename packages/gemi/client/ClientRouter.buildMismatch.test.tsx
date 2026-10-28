/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { Link } from "./Link";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { BUILD_HEADER, CHUNK_RELOAD_MARKER, __resetChunkLoadRecovery } from "./chunkLoadRecovery";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #1056: during a deploy two builds served one tab. A navigation's `.json` was
 * answered 200 by the other build, the router rendered that build's data with
 * this build's views, a view threw on a prop it did not know, and the tab
 * showed the error boundary until the user reloaded.
 */

function Layout(props: { children?: ReactNode }) {
  return (
    <section>
      <Link href={"/about" as never}>About</Link>
      {props.children}
    </section>
  );
}
function Home() {
  return <p data-view="Home">home</p>;
}
// This build's About takes `author.name`; the other build renamed it.
function About(props: { author: { name: string } }) {
  return <p data-view="About">{props.author.name}</p>;
}
function NotFound() {
  return <p data-view="404">not found</p>;
}

const viewImportMap = { Layout, Home, About, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", {
      "/": this.view("Home"),
      "/about": this.view("About"),
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
  buildId: "build-a",
} as unknown as ServerDataContextValue;

/** The other build's `/about.json`: its About takes `writer`. */
function aboutPayload(build: string, about: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      data: { "/about": { Layout: {}, About: about } },
      breadcrumbs: {},
      prefetchedData: {},
      meta: {},
      i18n: value.i18n,
      appId: "other-process",
    }),
    { status: 200, headers: { [BUILD_HEADER]: build } },
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const realFetch = globalThis.fetch;
const realLocation = window.location;
let assign: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  __resetChunkLoadRecovery();
  assign = vi.fn();
  reload = vi.fn();
  // jsdom's `location.assign` cannot be replaced (nor proxied: it is
  // non-configurable); everything the router's history reads stays live.
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

async function mount(serverData = value) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <ServerDataContext.Provider value={serverData}>
        <ClientRouter viewImportMap={viewImportMap} RootLayout={(p: any) => <>{p.children}</>} />
      </ServerDataContext.Provider>,
    );
  });
}

async function clickAbout() {
  await act(async () => {
    container!
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await act(async () => {});
}

describe("a navigation answered by another build (#1056)", () => {
  test("loads the target page in full instead of rendering the other build's data", async () => {
    globalThis.fetch = vi.fn(async () =>
      aboutPayload("build-b", { writer: { name: "Ada" } }),
    ) as unknown as typeof fetch;
    await mount();

    await clickAbout();

    expect(container!.textContent).not.toContain("Something went wrong");
    // `history.push` already moved the URL to the target, so the full load
    // of it is a reload.
    expect(realLocation.pathname).toBe("/about");
    expect(reload).toHaveBeenCalledTimes(1);
    // The page on screen stays until the full load replaces it.
    expect(text("Home")).toBe("home");
  });

  test("only once per page: a second mismatch within the cooldown renders the data", async () => {
    window.sessionStorage.setItem(
      CHUNK_RELOAD_MARKER,
      JSON.stringify({ [`${realLocation.origin}/about`]: Date.now() }),
    );
    globalThis.fetch = vi.fn(async () =>
      aboutPayload("build-b", { author: { name: "Ada" } }),
    ) as unknown as typeof fetch;
    await mount();

    await clickAbout();

    expect(reload).not.toHaveBeenCalled();
    expect(text("About")).toBe("Ada");
  });

  test("the same build renders as usual", async () => {
    globalThis.fetch = vi.fn(async () =>
      aboutPayload("build-a", { author: { name: "Ada" } }),
    ) as unknown as typeof fetch;
    await mount();

    await clickAbout();

    expect(reload).not.toHaveBeenCalled();
    expect(text("About")).toBe("Ada");
  });

  test("a document without a build id (dev, an older server) never compares", async () => {
    globalThis.fetch = vi.fn(async () =>
      aboutPayload("build-b", { author: { name: "Ada" } }),
    ) as unknown as typeof fetch;
    await mount({ ...value, buildId: undefined } as unknown as ServerDataContextValue);

    await clickAbout();

    expect(reload).not.toHaveBeenCalled();
    expect(text("About")).toBe("Ada");
  });
});
