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
      <Link href={"/contact" as never}>Contact</Link>
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
function Contact() {
  return <p data-view="Contact">contact</p>;
}
function NotFound() {
  return <p data-view="404">not found</p>;
}

const viewImportMap = { Layout, Home, About, Contact, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", {
      "/": this.view("Home"),
      "/about": this.view("About"),
      "/contact": this.view("Contact"),
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

async function clickAbout(href = "/about") {
  await act(async () => {
    container!
      .querySelector(`a[href="${href}"]`)!
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

/**
 * folio#2750: the full load is cancelled ("Stay" on a dirty editor's
 * `beforeunload` prompt, here a `reload` that does nothing) and the page keeps
 * running. Later navigations answered by the other build must still recover,
 * not be discarded behind a load that is never coming.
 */
describe("after a full load that was cancelled", () => {
  // Per path: which build answers it, and with what About data.
  let builds: Record<string, string>;
  let dirty: (event: BeforeUnloadEvent) => void;

  beforeEach(() => {
    builds = { "/.json": "build-a", "/about.json": "build-a", "/contact.json": "build-a" };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), realLocation.origin).pathname;
      const build = builds[path];
      if (path === "/about.json") return aboutPayload(build, { author: { name: "Ada" } });
      const route = path === "/contact.json" ? "/contact" : "/";
      const view = route === "/" ? "Home" : "Contact";
      return new Response(
        JSON.stringify({
          data: { [route]: { Layout: {}, [view]: {} } },
          breadcrumbs: {},
          prefetchedData: {},
          meta: {},
          i18n: value.i18n,
          appId: "other-process",
        }),
        { status: 200, headers: { [BUILD_HEADER]: build } },
      );
    }) as unknown as typeof fetch;
    // The dirty editor: asks before the page is left.
    dirty = (event) => event.preventDefault();
    window.addEventListener("beforeunload", dirty);
  });

  afterEach(() => {
    window.removeEventListener("beforeunload", dirty);
  });

  async function back() {
    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener("popstate", resolve, { once: true }),
      );
      window.history.back();
      await popped;
    });
    await act(async () => {});
  }

  /** Editor open on /about, then Back to `/` answered by the other build: "Stay". */
  async function cancelOnBack() {
    await mount();
    await clickAbout();
    expect(text("About")).toBe("Ada");

    builds["/.json"] = "build-b";
    await back();

    expect(realLocation.pathname).toBe("/");
    expect(reload).toHaveBeenCalledTimes(1);
    // Cancelled: the editor stays on screen.
    expect(text("About")).toBe("Ada");
  }

  test("a mismatch on another URL loads it in full", async () => {
    await cancelOnBack();

    builds["/contact.json"] = "build-b";
    await clickAbout("/contact");

    expect(realLocation.pathname).toBe("/contact");
    expect(reload).toHaveBeenCalledTimes(2);
    const marker = JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_MARKER)!);
    expect(Object.keys(marker).sort()).toEqual(
      [`${realLocation.origin}/`, `${realLocation.origin}/contact`].sort(),
    );
  });

  test("the same URL inside the cooldown renders the data instead of being discarded", async () => {
    await cancelOnBack();

    await clickAbout("/contact");
    expect(text("Contact")).toBe("contact");
    await back();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(text("Home")).toBe("home");
  });

  test("the same URL after the cooldown loads it in full again", async () => {
    await cancelOnBack();

    const later = Date.now() + 31_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    await clickAbout("/contact");
    expect(text("Contact")).toBe("contact");
    await back();

    expect(realLocation.pathname).toBe("/");
    expect(reload).toHaveBeenCalledTimes(2);
    expect(text("Contact")).toBe("contact");
  });
});
