/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { Link } from "./Link";
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
 * #1134: on a direct load the route state held the route *template* as the
 * location's pathname, and after a client navigation the *resolved* URL as the
 * route's. `useRoute().pathname` is the template and `useLocation().pathname`
 * the resolved URL, the same on the first render and after a navigation.
 */

function Probe() {
  const route = useRoute();
  const location = useLocation();
  return (
    <p
      data-probe
      data-route={route.pathname}
      data-location={location.pathname}
      // A breadcrumb showing the user's crumbs on every page under it.
      data-crumb={String(route.pathname.startsWith("/users/:userId"))}
      data-starts={String(route.startsWith("/users/:userId" as never))}
    />
  );
}

function UserLayout(props: { children?: ReactNode }) {
  const params = { userId: "7" };
  return (
    <section>
      <Probe />
      <Link data-tab="show" href={"/users/:userId" as never} params={params as never}>
        Show
      </Link>
      <Link data-tab="ai" href={"/users/:userId/ai" as never} params={params as never}>
        AI
      </Link>
      <Link data-tab="edit" href={"/users/:userId/edit" as never} params={params as never}>
        Edit
      </Link>
      {props.children}
    </section>
  );
}
const UserShow = () => <p data-view="UserShow">show</p>;
const UserAi = () => <p data-view="UserAi">ai</p>;
const UserEdit = () => <p data-view="UserEdit">edit</p>;
const NotFound = () => <p data-view="404">not found</p>;

const viewImportMap = { UserLayout, UserShow, UserAi, UserEdit, 404: NotFound } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/users/:userId": this.layout("UserLayout", {
      "/": this.view("UserShow"),
      "/ai": this.view("UserAi"),
      "/edit": this.view("UserEdit"),
    }),
  };
}

const componentTree = [["404", []], ...createComponentTree({ "/": AppRouter })] as any;
const routeManifest = createRouteManifest({ "/": AppRouter });

const i18n = {
  dictionary: {},
  currentLocale: "en-US",
  supportedLocales: ["en-US", "de-DE"],
  defaultLocale: "en-US",
};

/** The document's payload, as the server builds it for a direct load. */
function documentData(currentPath: string, route: string, urlLocaleSegment: string | null) {
  const dataKey = urlLocaleSegment ? currentPath.slice(urlLocaleSegment.length + 1) : currentPath;
  return {
    routeManifest,
    pageData: { [dataKey]: { UserLayout: {}, UserAi: {} } },
    breadcrumbs: {},
    prefetchedData: {},
    router: {
      pathname: route,
      params: { userId: "7" },
      currentPath,
      is404: false,
      searchParams: "",
      urlLocaleSegment,
      domain: null,
    },
    i18n: { ...i18n, currentLocale: urlLocaleSegment ?? "en-US" },
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

const probe = () => container!.querySelector("[data-probe]")!;
const tab = (name: string) =>
  container!.querySelector<HTMLAnchorElement>(`[data-tab="${name}"]`)!;
const activeTabs = () =>
  Array.from(container!.querySelectorAll("[data-tab]"))
    .filter((a) => a.getAttribute("data-active") === "true")
    .map((a) => a.getAttribute("data-tab"));

function snapshot() {
  return {
    route: probe().getAttribute("data-route"),
    location: probe().getAttribute("data-location"),
    crumb: probe().getAttribute("data-crumb"),
    starts: probe().getAttribute("data-starts"),
    active: activeTabs(),
  };
}

/** Server render, then hydration, of a direct load. */
async function directLoad(value: ServerDataContextValue, url: string) {
  window.history.replaceState(null, "", url);
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

describe("useRoute / useLocation on a route with params (#1134)", () => {
  test("a direct load reports the template and the resolved URL, server and client", async () => {
    const { server, errors } = await directLoad(
      documentData("/users/7/ai", "/users/:userId/ai", null),
      "/users/7/ai",
    );

    const expected = {
      route: "/users/:userId/ai",
      location: "/users/7/ai",
      crumb: "true",
      starts: "true",
      active: ["ai"],
    };
    expect(server, "server render").toEqual(expected);
    expect(errors, "hydration").toEqual([]);
    expect(snapshot(), "after hydration").toEqual(expected);
  });

  test("a direct load in a non-default locale reports the URL without its locale segment", async () => {
    const { server, errors } = await directLoad(
      documentData("/de-DE/users/7/ai", "/users/:userId/ai", "de-DE"),
      "/de-DE/users/7/ai",
    );

    expect(server.route).toBe("/users/:userId/ai");
    expect(server.location).toBe("/users/7/ai");
    expect(errors).toEqual([]);
    expect(snapshot().route).toBe("/users/:userId/ai");
    expect(snapshot().location).toBe("/users/7/ai");
  });

  test("a client navigation reports the same shapes as a direct load", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { "/users/7/edit": { UserLayout: {}, UserEdit: {} } },
          breadcrumbs: {},
          prefetchedData: {},
          meta: {},
          i18n,
          appId: "test",
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await directLoad(documentData("/users/7/ai", "/users/:userId/ai", null), "/users/7/ai");

    await act(async () => {
      tab("edit").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await act(async () => {});

    expect(window.location.pathname).toBe("/users/7/edit");
    expect(container!.querySelector('[data-view="UserEdit"]')).not.toBeNull();
    expect(snapshot()).toEqual({
      route: "/users/:userId/edit",
      location: "/users/7/edit",
      crumb: "true",
      starts: "true",
      active: ["edit"],
    });
  });
});
