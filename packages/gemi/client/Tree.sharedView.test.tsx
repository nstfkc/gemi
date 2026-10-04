/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";

import { Tree } from "./ClientRouter";
import { ComponentsProvider } from "./ComponentContext";
import { QueryManagerProvider } from "./QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { ViewRouter } from "../http/ViewRouter";
import { createComponentTree } from "../services/router/createComponentTree";
import { createRouteManifest } from "../services/router/createRouteManifest";

/**
 * #788: a view used by more than one route rendered once per route — two
 * Suspense boundaries and two React trees, server-side and after hydration.
 * The tree and the entries come from the real builders so the whole path from
 * route table to rendered markup is covered.
 */

function Layout(props: { children?: React.ReactNode }) {
  return <section data-view="Layout">{props.children}</section>;
}
function Home() {
  return <p data-view="Home">home</p>;
}
function SharedPreview() {
  return <p data-view="SharedPreview">preview</p>;
}
function Dashboard() {
  return <p data-view="Dashboard">dashboard</p>;
}

const viewImportMap = { Layout, Home, SharedPreview, Dashboard } as any;

class AppRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    // Legacy path, redirects to the one below — same view (the kyte shape).
    "/pages/:pageId/preview": this.view("SharedPreview", async () => {
      throw new Error("redirects");
    }),
    "/previews/:token": this.view("SharedPreview"),
    // The same view again, this time inside a layout: a different depth.
    "/app": this.layout("Layout", {
      "/": this.view("Dashboard"),
      "/preview": this.view("SharedPreview"),
    }),
    // And the same layout under a second prefix.
    "/admin": this.layout("Layout", {
      "/": this.view("Home"),
    }),
  };
}

const componentTree = [["404", []], ...createComponentTree({ "/": AppRouter })] as any;
const manifest = createRouteManifest({ "/": AppRouter });

function App(props: { routePath: string }) {
  return (
    <QueryManagerProvider>
      <ComponentsProvider viewImportMap={viewImportMap}>
        <RouteStateProvider state={{ data: {} } as unknown as RouteState & PageData}>
          <Tree
            action={null as any}
            tree={componentTree}
            entries={manifest[props.routePath]}
            pathname={props.routePath}
          />
        </RouteStateProvider>
      </ComponentsProvider>
    </QueryManagerProvider>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function count(el: ParentNode, view: string) {
  return el.querySelectorAll(`[data-view="${view}"]`).length;
}

describe("a view shared by several routes (#788)", () => {
  test.each([
    ["/previews/:token", { SharedPreview: 1, Layout: 0, Home: 0 }],
    ["/pages/:pageId/preview", { SharedPreview: 1, Layout: 0, Home: 0 }],
    ["/", { Home: 1, SharedPreview: 0, Layout: 0 }],
    ["/app/preview", { Layout: 1, SharedPreview: 1, Dashboard: 0 }],
    ["/app", { Layout: 1, Dashboard: 1, SharedPreview: 0 }],
    ["/admin", { Layout: 1, Home: 1, Dashboard: 0 }],
  ])("%s renders each view once, server and client", async (routePath, expected) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(<App routePath={routePath} />);

    for (const [view, n] of Object.entries(expected)) {
      expect(count(container, view), `server ${view}`).toBe(n);
    }

    const errors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container!, <App routePath={routePath} />, {
        onRecoverableError: (e) => errors.push(e),
      });
    });

    expect(errors).toEqual([]);
    for (const [view, n] of Object.entries(expected)) {
      expect(count(container, view), `client ${view}`).toBe(n);
    }
  });

  test("one Suspense boundary per segment, and the view nests in its layout", () => {
    const boundaries = (html: string) => html.split("<!--$-->").length - 1;

    expect(boundaries(renderToString(<App routePath="/previews/:token" />))).toBe(1);

    const nested = renderToString(<App routePath="/app/preview" />);
    expect(boundaries(nested)).toBe(2);
    expect(nested).toMatch(/<section data-view="Layout"><!--\$--><p data-view="SharedPreview">/);
  });
});
