/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { useNavigate } from "./useNavigate";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #1215: the scroll was reset only when the view on screen changed, so two
 * pages rendered by the same view (`/:slug` → `/:slug`) kept the previous
 * page's position, and back/forward restored by URL, once.
 */

let navigate: ReturnType<typeof useNavigate>;

function Layout(props: { children?: ReactNode }) {
  navigate = useNavigate();
  return <section>{props.children}</section>;
}
function Page(props: { slug?: string }) {
  return (
    <>
      <p data-view="Page">{props.slug}</p>
      <h2 id="details">details</h2>
    </>
  );
}
function Detail(props: { id?: string }) {
  return <p data-view="Detail">{props.id}</p>;
}
function NotFound() {
  return <p data-view="404">not found</p>;
}

const viewImportMap = { Layout, Page, Detail, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", {
      "/:slug": this.view("Page"),
      "/detail/:id": this.view("Detail"),
    }),
  };
}

const componentTree = [["404", []], ...createComponentTree({ "/": AppRouter })] as any;
const routeManifest = createRouteManifest({ "/": AppRouter });

const value = {
  routeManifest,
  pageData: { "/home": { Layout: {}, Page: { slug: "home" } } },
  breadcrumbs: {},
  prefetchedData: {},
  router: {
    pathname: "/:slug",
    params: { slug: "home" },
    currentPath: "/home",
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
  componentTree,
  auth: { user: null },
  features: {},
  __csrf: "",
  cssManifest: {},
  modulePreloadManifest: {},
  meta: {},
  appId: "test",
} as unknown as ServerDataContextValue;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const realFetch = globalThis.fetch;
const realScrollTo = window.scrollTo;
let scrolledTo: Element[] = [];

/** The window's scroll, as the router reads and sets it. */
function scrollWindow(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

beforeEach(() => {
  scrolledTo = [];
  scrollWindow(0);
  window.scrollTo = vi.fn((x: number | ScrollToOptions, y?: number) => {
    scrollWindow(typeof x === "number" ? (y ?? 0) : (x.top ?? 0));
  }) as typeof window.scrollTo;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this);
    scrollWindow(1234);
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const segments = new URL(String(input), "http://localhost").pathname
      .replace(/\.json$/, "")
      .split("/")
      .filter(Boolean);
    const slug = segments.at(-1);
    const detail = segments.at(-2) === "detail";
    return new Response(
      JSON.stringify({
        data: detail
          ? { [`/detail/${slug}`]: { Layout: {}, Detail: { id: slug } } }
          : { [`/${slug}`]: { Layout: {}, Page: { slug } } },
        breadcrumbs: {},
        prefetchedData: {},
        meta: {},
        i18n: value.i18n,
        appId: "test",
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = realFetch;
  window.scrollTo = realScrollTo;
});

const slug = () => container!.querySelector(`[data-view="Page"]`)?.textContent ?? null;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function mount() {
  window.history.replaceState(null, "", "/home");
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
  expect(slug()).toBe("home");
}

async function push(
  path: string,
  options?: { hash?: string; shallow?: boolean; search?: Record<string, string> },
) {
  await act(async () => {
    void navigate.push(path as never, options as never);
  });
  await settle();
}

async function traverse(delta: number) {
  await act(async () => {
    window.history.go(delta);
  });
  await settle();
}

describe("scroll on client-side navigation (#1215)", () => {
  test("every push between pages of the same view starts at the top", async () => {
    await mount();

    scrollWindow(800);
    await push("/menu");
    expect(slug()).toBe("menu");
    expect(window.scrollY).toBe(0);

    scrollWindow(600);
    await push("/book");
    expect(slug()).toBe("book");
    expect(window.scrollY).toBe(0);

    scrollWindow(300);
    await push("/home");
    expect(slug()).toBe("home");
    expect(window.scrollY).toBe(0);
  });

  test("back and forward return to where each entry was left", async () => {
    await mount();

    scrollWindow(800);
    await push("/menu");
    scrollWindow(600);
    await push("/book");
    scrollWindow(300);
    // The same URL again: its own entry, its own position.
    await push("/menu");
    scrollWindow(50);

    await traverse(-1);
    expect(slug()).toBe("book");
    expect(window.scrollY).toBe(300);

    await traverse(-1);
    expect(slug()).toBe("menu");
    expect(window.scrollY).toBe(600);

    await traverse(-1);
    expect(slug()).toBe("home");
    expect(window.scrollY).toBe(800);

    // Each entry restores as often as it is returned to.
    await traverse(1);
    expect(slug()).toBe("menu");
    expect(window.scrollY).toBe(600);

    await traverse(2);
    expect(slug()).toBe("menu");
    expect(window.scrollY).toBe(50);
  });

  test("a push with a hash scrolls to its element", async () => {
    await mount();

    scrollWindow(800);
    await push("/menu", { hash: "#details" });
    expect(slug()).toBe("menu");
    expect(scrolledTo.map((element) => element.id)).toEqual(["details"]);
    expect(window.scrollY).toBe(1234);
  });

  test("a hash without an element on the page goes to the top", async () => {
    await mount();

    scrollWindow(800);
    await push("/menu", { hash: "#nowhere" });
    expect(slug()).toBe("menu");
    expect(scrolledTo).toEqual([]);
    expect(window.scrollY).toBe(0);
  });

  test("a shallow navigation keeps the position", async () => {
    await mount();

    scrollWindow(800);
    await push("/home", { shallow: true });
    expect(window.location.pathname).toBe("/home");
    expect(window.scrollY).toBe(800);
  });

  test("back to a filtered list from a detail page restores where it was left", async () => {
    await mount();

    scrollWindow(100);
    // A filter: `searchParams.push()` is a shallow push on the list's own path.
    await push("/home", { search: { status: "open" }, shallow: true });
    expect(window.scrollY).toBe(100);
    scrollWindow(830);

    await push("/detail/1");
    expect(container!.querySelector(`[data-view="Detail"]`)?.textContent).toBe("1");
    expect(window.scrollY).toBe(0);
    scrollWindow(200);

    await traverse(-1);
    expect(window.location.search).toBe("?status=open");
    expect(slug()).toBe("home");
    expect(window.scrollY).toBe(830);

    // And forward to the detail page returns to where it was left too.
    await traverse(1);
    expect(window.scrollY).toBe(200);
  });

  test("a new filter on a scrolled list keeps the position", async () => {
    await mount();

    await push("/home", { search: { status: "open" }, shallow: true });
    scrollWindow(830);
    await push("/home", { search: { status: "closed" }, shallow: true });
    expect(window.location.search).toBe("?status=closed");
    expect(window.scrollY).toBe(830);
  });

  test("back and forward between shallow entries of one page restore each", async () => {
    await mount();

    scrollWindow(100);
    await push("/home", { search: { status: "open" }, shallow: true });
    scrollWindow(830);
    await push("/home", { search: { status: "closed" }, shallow: true });
    scrollWindow(400);

    await traverse(-1);
    expect(window.location.search).toBe("?status=open");
    expect(window.scrollY).toBe(830);

    await traverse(-1);
    expect(window.location.search).toBe("");
    expect(window.scrollY).toBe(100);

    await traverse(2);
    expect(window.location.search).toBe("?status=closed");
    expect(window.scrollY).toBe(400);
  });

  test("the browser's own restoration is off", async () => {
    await mount();
    expect(window.history.scrollRestoration).toBe("manual");
  });
});
