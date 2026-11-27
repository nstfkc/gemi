/** @vitest-environment jsdom */
import "urlpattern-polyfill";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ClientRouterContext, ClientRouterProvider } from "./ClientRouterContext";
import type { RouteState } from "./RouteStateContext";
import type { Subject } from "../utils/Subject";

// Dev-server reload wiring; vitest's `import.meta.hot` has no `off`.
vi.mock("./HttpReload", () => ({ HttpReload: () => null }));

/**
 * In-app navigation and back/forward hand a view the same decoded params the
 * server gives on a direct visit (#1322).
 */

const routeManifest = {
  "/notes/:id": ["Note"],
  "/notes/:id/edit": ["EditNote"],
  "/about": ["About"],
};

let root: Root;
let router!: { history: any; routerSubject: Subject<RouteState> };

function mount(initial: { pathname: string; params: Record<string, string> }) {
  function Probe() {
    router = useContext(ClientRouterContext) as any;
    return null;
  }
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        ClientRouterProvider,
        {
          pathname: initial.pathname,
          currentPath: "",
          routeManifest,
          cssManifest: {},
          modulePreloadManifest: {},
          pageData: {},
          urlLocaleSegment: null,
          params: initial.params,
          searchParams: "",
          is404: false,
          is500: false,
          breadcrumbs: {},
        },
        createElement(Probe),
      ),
    );
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/notes/a%2Fb");
});

afterEach(() => {
  act(() => root.unmount());
});

describe("client view route params", () => {
  test("the hydrated route keeps the server's decoded ID and its URL", () => {
    mount({ pathname: "/notes/:id", params: { id: "a/b" } });
    expect(router.routerSubject.value.params).toEqual({ id: "a/b" });
    // Rebuilt from the template: `a/b` stays one segment.
    expect(router.routerSubject.value.pathname).toBe("/notes/a%2Fb");
  });

  test.each([
    ["/notes/42", "42"],
    ["/notes/a%2Fb", "a/b"],
    ["/notes/%252F", "%2F"],
    ["/notes/100%25", "100%"],
  ])("navigating to %s gives %j", (path, id) => {
    mount({ pathname: "/about", params: {} });
    act(() => router.history.push(path));
    const state = router.routerSubject.value;
    expect(state.routePath).toBe("/notes/:id");
    expect(state.params).toEqual({ id });
  });

  test("back and forward give the decoded ID again", async () => {
    mount({ pathname: "/notes/:id", params: { id: "a/b" } });
    act(() => router.history.push("/about"));
    expect(router.routerSubject.value.routePath).toBe("/about");

    await act(async () => {
      const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
      router.history.back();
      await popped;
    });
    expect(router.routerSubject.value.routePath).toBe("/notes/:id");
    expect(router.routerSubject.value.params).toEqual({ id: "a/b" });
  });

  test("a malformed escape gives no params", () => {
    mount({ pathname: "/about", params: {} });
    act(() => router.history.push("/notes/%E0%A4%A"));
    expect(router.routerSubject.value.params).toEqual({});
  });
});
