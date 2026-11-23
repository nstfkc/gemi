/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { Link } from "./Link";
import { useNavigate } from "./useNavigate";
import { useSearchParams } from "./useSearchParams";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #1383: a navigation sent from the effect of a view that a client navigation
 * just mounted changed the address bar, but the router never followed it. Its
 * subscription to the history was torn down and re-made in that same commit,
 * and the history event landed in between.
 */

function Layout(props: { children?: ReactNode }) {
  return (
    <section>
      <Link href={"/items/1" as never}>Item</Link>
      {props.children}
    </section>
  );
}
function Home() {
  return <p data-view="Home">home</p>;
}
function Item() {
  const { replace } = useNavigate();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab");
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).get("tab")) {
      void replace("/items/:id" as never, { params: { id: "1" }, search: { tab: "a" } } as never);
    }
  }, [replace]);
  return <p data-view="Item">{tab ?? "none"}</p>;
}
function NotFound() {
  return <p data-view="404">not found</p>;
}

const viewImportMap = { Layout, Home, Item, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", {
      "/": this.view("Home"),
      "/items/:id": this.view("Item"),
    }),
  };
}

const componentTree = [["404", []], ...createComponentTree({ "/": AppRouter })] as any;
const routeManifest = createRouteManifest({ "/": AppRouter });

const value = {
  routeManifest,
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
  window.history.replaceState(null, "", "/");
});

const text = (view: string) =>
  container!.querySelector(`[data-view="${view}"]`)?.textContent ?? null;

describe("a navigation from the mount effect of a view a client navigation rendered (#1383)", () => {
  test("is followed by the router", async () => {
    window.history.replaceState(null, "", "/");
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          data: { "/items/:id": { Layout: {}, Item: {} } },
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
    expect(text("Home")).toBe("home");

    await act(async () => {
      container!
        .querySelector("a")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {});
    }

    expect(window.location.pathname).toBe("/items/1");
    expect(window.location.search).toBe("?tab=a");
    expect(urls.some((url) => url.includes("/items/1.json?tab=a"))).toBe(true);
    expect(text("Item")).toBe("a");
  });
});
