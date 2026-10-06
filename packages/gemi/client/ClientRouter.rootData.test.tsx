/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

// Vitest's `import.meta.hot` has `on` but no `off`, so the dev-only reload
// listener throws on unmount. It plays no part in what is tested here.
vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #819: `Routes` resolved the Tree's pathname with `applyParams`, which strips
 * the trailing slash, so the root route came out as `""`. The server keys page
 * data under `/`, so the root view and its layout rendered with `{}` props —
 * in the server render and again after hydration.
 */

function Layout(props: { title?: string; children?: ReactNode }) {
  return (
    <section data-view="Layout" data-title={props.title ?? "missing"}>
      {props.children}
    </section>
  );
}
function Home(props: { greeting?: string }) {
  return <p data-view="Home">{props.greeting ?? "missing"}</p>;
}
function About(props: { greeting?: string }) {
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

function serverData(pathname: string, pageData: ServerDataContextValue["pageData"]) {
  return {
    routeManifest,
    pageData,
    breadcrumbs: {},
    prefetchedData: {},
    router: {
      pathname,
      params: {},
      currentPath: pathname,
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
}

function RootLayout(props: { children: ReactNode }) {
  return <>{props.children}</>;
}

function App(props: { value: ServerDataContextValue }) {
  return (
    <ServerDataContext.Provider value={props.value}>
      <ClientRouter viewImportMap={viewImportMap} RootLayout={RootLayout} />
    </ServerDataContext.Provider>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  window.history.replaceState(null, "", "/");
});

const text = (view: string) =>
  container!.querySelector(`[data-view="${view}"]`)?.textContent ?? null;
const title = () =>
  container!.querySelector('[data-view="Layout"]')?.getAttribute("data-title") ?? null;

describe("page data for the root route (#819)", () => {
  test.each([
    ["/", "Home"],
    ["/about", "About"],
  ])("%s view and layout get their props, server and client", async (pathname, view) => {
    window.history.replaceState(null, "", pathname);
    const value = serverData(pathname, {
      [pathname]: {
        Layout: { title: "from layout" },
        [view]: { greeting: `hello from ${view}` },
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(<App value={value} />);

    expect(text(view), "server view").toBe(`hello from ${view}`);
    expect(title(), "server layout").toBe("from layout");

    const errors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container!, <App value={value} />, {
        onRecoverableError: (e) => errors.push(e),
      });
    });

    expect(errors).toEqual([]);
    expect(text(view), "client view").toBe(`hello from ${view}`);
    expect(title(), "client layout").toBe("from layout");
  });
});
