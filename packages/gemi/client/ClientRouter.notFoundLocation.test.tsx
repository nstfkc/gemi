/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { useLocation } from "./useLocation";
import { useRoute } from "./useRoute";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

// Vitest's `import.meta.hot` has `on` but no `off`, so the dev-only reload
// listener throws on unmount. It plays no part in what is tested here.
vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #952: on a 404 document `router.pathname` is null (nothing matched), and the
 * `404` view read that through `useLocation()`. It now reads the requested
 * path, without its locale segment, in the server render and after hydration.
 */

function NotFound() {
  const location = useLocation();
  const route = useRoute();
  return (
    <p data-view="404" data-starts={String(route.startsWith("/pages" as never))}>
      {`${location.pathname}|${location.search}`}
    </p>
  );
}
function Home() {
  return <p data-view="Home">home</p>;
}

const viewImportMap = { Home, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
  };
}

const componentTree = [["404", []], ...createComponentTree({ "/": AppRouter })] as any;
const routeManifest = createRouteManifest({ "/": AppRouter });

function notFoundData(currentPath: string, search: string, urlLocaleSegment: string | null) {
  return {
    routeManifest,
    pageData: { [currentPath]: {} },
    breadcrumbs: {},
    prefetchedData: {},
    router: {
      pathname: null,
      params: {},
      currentPath,
      is404: true,
      searchParams: search,
      urlLocaleSegment,
      domain: null,
    },
    i18n: {
      dictionary: {},
      currentLocale: urlLocaleSegment ?? "en-US",
      supportedLocales: ["en-US", "de-DE"],
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

const notFound = () => container!.querySelector('[data-view="404"]');

describe("useLocation in the 404 view (#952)", () => {
  test.each([
    ["/pages/aB3dE9xYz/assets", "?tab=1", null, "/pages/aB3dE9xYz/assets", "true"],
    ["/does/not/exist", "", null, "/does/not/exist", "false"],
    ["/de-DE/pages/x", "", "de-DE", "/pages/x", "true"],
  ])(
    "%s reads its own path, server and client",
    async (currentPath, search, locale, pathname, startsWith) => {
      window.history.replaceState(null, "", `${currentPath}${search}`);
      const value = notFoundData(currentPath, search, locale);

      container = document.createElement("div");
      document.body.appendChild(container);
      container.innerHTML = renderToString(<App value={value} />);

      expect(notFound()?.textContent, "server").toBe(`${pathname}|${search}`);
      expect(notFound()?.getAttribute("data-starts")).toBe(startsWith);

      const errors: unknown[] = [];
      await act(async () => {
        root = hydrateRoot(container!, <App value={value} />, {
          onRecoverableError: (e) => errors.push(e),
        });
      });

      expect(errors).toEqual([]);
      expect(notFound()?.textContent, "client").toBe(`${pathname}|${search}`);
    },
  );
});
