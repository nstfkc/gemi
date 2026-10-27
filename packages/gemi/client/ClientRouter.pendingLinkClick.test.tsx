/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { Link } from "./Link";
import { useNavigate } from "./useNavigate";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #1048: a second click on a link whose navigation was still loading was
 * pushed as shallow — `Link` read "where am I" from `window.location`, which
 * `history.push` had already moved to the target — and the router committed
 * the target's views on the previous page's data.
 */

function Layout(props: { children?: ReactNode }) {
  return (
    <section>
      <Link href={"/about" as never}>About</Link>
      {props.children}
    </section>
  );
}
function Home(props: { greeting?: string }) {
  const { push } = useNavigate();
  return (
    <>
      <p data-view="Home">{props.greeting ?? "missing"}</p>
      <button onClick={() => push("/about" as never, { shallow: true } as never)}>
        shallow
      </button>
    </>
  );
}
function About(props: { greeting?: string }) {
  const { replace } = useNavigate();
  // folio's pattern: once the route has committed, a layout effect sends a
  // search write that was held back while the push was in flight.
  useLayoutEffect(() => {
    if (window.location.search === "" && window.location.pathname === "/about") {
      if ((globalThis as any).__shallowReplaceOnCommit) {
        void replace("/about" as never, { search: { tab: "2" }, shallow: true } as never);
      }
    }
  });
  return <p data-view="About">{props.greeting ?? "missing"}</p>;
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

const componentTree = [["404", []], ...createComponentTree({ "/": AppRouter })] as any;
const routeManifest = createRouteManifest({ "/": AppRouter });

const value = {
  routeManifest,
  pageData: { "/": { Layout: {}, Home: { greeting: "hello from Home" } } },
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

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = realFetch;
  delete (globalThis as any).__shallowReplaceOnCommit;
  window.history.replaceState(null, "", "/");
});

const text = (view: string) =>
  container!.querySelector(`[data-view="${view}"]`)?.textContent ?? null;

function click(anchor: HTMLAnchorElement) {
  act(() => {
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

describe("a second click on a link whose navigation is pending (#1048)", () => {
  test("does not render the target view without its data", async () => {
    window.history.replaceState(null, "", "/");
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          if (String(input).includes("about")) {
            responses.push(resolve);
          }
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    expect(text("Home")).toBe("hello from Home");

    const anchor = container.querySelector("a")!;
    click(anchor);
    expect(window.location.pathname).toBe("/about");
    expect(responses).toHaveLength(1);

    // Same link again while `/about.json` is still in flight.
    click(anchor);
    await act(async () => {});

    expect(window.history.state?.usr?.shallow).toBeFalsy();
    expect(text("About"), "target rendered on the previous page's data").toBeNull();
    expect(text("Home")).toBe("hello from Home");
    // Ignored: no second history entry and no second request.
    expect(responses).toHaveLength(1);

    await act(async () => {
      responses[0](
        new Response(
          JSON.stringify({
            data: { "/about": { Layout: {}, About: { greeting: "hello from About" } } },
            breadcrumbs: {},
            prefetchedData: {},
            meta: {},
            i18n: value.i18n,
            appId: "test",
          }),
          { status: 200 },
        ),
      );
    });
    await act(async () => {});

    expect(text("About")).toBe("hello from About");
  });

  test("a shallow push to a route with other views is fetched, not committed on stale data", async () => {
    window.history.replaceState(null, "", "/");
    const responses: Array<(response: Response) => void> = [];
    globalThis.fetch = vi.fn(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          if (String(input).includes("about")) {
            responses.push(resolve);
          }
        }),
    ) as unknown as typeof fetch;

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

    click(container.querySelector("button") as unknown as HTMLAnchorElement);
    await act(async () => {});

    expect(text("About")).toBeNull();
    expect(responses).toHaveLength(1);
  });

  test("a shallow replace sent from a layout effect right after the route commits is not fetched", async () => {
    window.history.replaceState(null, "", "/");
    (globalThis as any).__shallowReplaceOnCommit = true;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          data: { "/about": { Layout: {}, About: { greeting: "hello from About" } } },
          breadcrumbs: {},
          prefetchedData: {},
          meta: {},
          i18n: value.i18n,
          appId: "test",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

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

    click(container.querySelector("a")!);
    await act(async () => {});
    await act(async () => {});

    expect(window.location.pathname).toBe("/about");
    expect(window.location.search).toBe("?tab=2");
    // Same views as on screen: the shallow replace keeps the data, no refetch.
    expect(urls.filter((url) => url.includes("about"))).toHaveLength(1);
    expect(text("About")).toBe("hello from About");
  });
});
