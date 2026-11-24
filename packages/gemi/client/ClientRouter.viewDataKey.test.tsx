/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";
import { Link } from "./Link";
import { useParams } from "./useParams";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";
import { matchViewRoute } from "../services/router/matchViewRoute";
import { createFlatViewRoutes } from "../services/router/createFlatViewRoutes";

// Vitest's `import.meta.hot` has `on` but no `off`, so the dev-only reload
// listener throws on unmount. It plays no part in what is tested here.
vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The server files a view's loader data under the path that was requested,
 * and the client must look it up under that same path, not one rebuilt from
 * the decoded params (#1322). Decoding is many-to-one: `/u/john@x.com` and
 * `/u/john%40x.com` both give `john@x.com`, and re-encoding picks `%40`,
 * which is not what the browser sent. A view on such a path got `{}`.
 */

function Profile(props: { name?: string }) {
  const params = useParams() as { id?: string };
  return (
    <>
      <p data-probe data-name={props.name ?? "(none)"} data-id={params.id ?? ""} />
      <Link data-to="email" href={"/u/john@x.com" as never}>email</Link>
      <Link data-to="tab" href={"/u/:id" as never} search={{ tab: "2" } as never}>tab</Link>
      <Link data-to="tag" href={"/u/c++" as never}>tag</Link>
    </>
  );
}
const NotFound = () => <p data-view="404">not found</p>;

const viewImportMap = { Profile, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/u/:id": this.view("Profile"),
  };
}

const componentTree = [["404", []], ...createComponentTree({ "/": AppRouter })] as any;
const routeManifest = createRouteManifest({ "/": AppRouter });
const flatViewRoutes = createFlatViewRoutes({ "/": AppRouter } as any);

/** The document's payload for `path`, keyed and matched as the server does. */
function documentData(path: string) {
  const match = matchViewRoute(flatViewRoutes, path);
  expect(match, `server match for ${path}`).not.toBeNull();
  return {
    routeManifest,
    pageData: { [path]: { Profile: { name: "loaded" } } },
    breadcrumbs: {},
    prefetchedData: {},
    router: {
      pathname: match!.routePath,
      params: match!.params,
      currentPath: path,
      is404: false,
      searchParams: "",
      urlLocaleSegment: null,
      domain: null,
    },
    i18n: { dictionary: {}, currentLocale: "en-US", supportedLocales: ["en-US"], defaultLocale: "en-US" },
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
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = realFetch;
  window.history.replaceState(null, "", "/");
});

const snapshot = () => {
  const probe = container!.querySelector("[data-probe]");
  return { name: probe?.getAttribute("data-name"), id: probe?.getAttribute("data-id") };
};

const cases: [string, string][] = [
  ["/u/john@x.com", "john@x.com"],
  ["/u/john%40x.com", "john@x.com"],
  ["/u/c++", "c++"],
  ["/u/a:b", "a:b"],
  ["/u/a,b", "a,b"],
  ["/u/a%2Fb", "a/b"],
  ["/u/a%2fb", "a/b"],
];

async function directLoad(path: string) {
  const value = documentData(path);
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  container.innerHTML = renderToString(<App value={value} />);
  const server = snapshot();
  const errors: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(container!, <App value={value} />, {
      onRecoverableError: (e) => errors.push(e),
    });
  });
  return { server, errors };
}

describe("a view's loader data on a path whose params re-encode differently", () => {
  test.each(cases)("%s renders with its data, server and client", async (path, id) => {
    const { server, errors } = await directLoad(path);
    expect(server, "server render").toEqual({ name: "loaded", id });
    expect(errors, "hydration").toEqual([]);
    expect(snapshot(), "after hydration").toEqual({ name: "loaded", id });
  });

  test.each([
    ["email", "/u/john@x.com", "john@x.com"],
    ["tag", "/u/c++", "c++"],
  ])("a client navigation to the %s page renders with its data", async (to, path, id) => {
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      // The server files the payload under the path it was asked for.
      const url = new URL(String(input), "http://gemi.dev");
      requested.push(url.pathname);
      const key = url.pathname.replace(/\.json$/, "");
      return new Response(
        JSON.stringify({
          data: { [key]: { Profile: { name: `navigated to ${id}` } } },
          breadcrumbs: {},
          prefetchedData: {},
          meta: {},
          i18n: { dictionary: {}, currentLocale: "en-US", supportedLocales: ["en-US"], defaultLocale: "en-US" },
          appId: "test",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await directLoad("/u/first");
    await act(async () => {
      container!
        .querySelector(`[data-to="${to}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await act(async () => {});

    expect(requested).toHaveLength(1);
    expect(window.location.pathname).toBe(path);
    expect(snapshot()).toEqual({ name: `navigated to ${id}`, id });
  });

  test.each([
    ["/u/john@x.com", "john@x.com"],
    ["/u/c++", "c++"],
  ])("a shallow click on %s keeps its data under the new spelling", async (path, id) => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    await directLoad(path);
    await act(async () => {
      container!
        .querySelector('[data-to="tab"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await act(async () => {});

    expect(window.location.search).toBe("?tab=2");
    expect(window.location.pathname).toBe(`/u/${encodeURIComponent(id)}`);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(snapshot()).toEqual({ name: "loaded", id });
  });
});
