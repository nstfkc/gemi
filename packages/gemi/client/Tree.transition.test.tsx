/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, startTransition, useState } from "react";
import { cleanup, render } from "@testing-library/react";

import { Tree } from "./ClientRouter";
import { ComponentsProvider } from "./ComponentContext";
import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useQuery } from "./useQuery";
import type { ComponentTree } from "./types";

/**
 * Regression test for the blank-page navigation bug: `Route`'s Suspense
 * boundary used to be keyed by view path, so a leaf swap (Home → Pricing)
 * mounted a brand-new boundary inside the transition. The layout's chrome
 * changes on every navigation (new route data), and the moment any sibling
 * content commits, React reveals a new boundary's fallback instead of
 * waiting — the outgoing page blanked to `null` while the incoming one
 * loaded. Boundaries are now keyed by tree slot, so they stay revealed
 * across the swap and the transition keeps the previous page on screen.
 */

function Layout(props: { label?: string; children?: React.ReactNode }) {
  return (
    <div>
      <div>{`layout:${props.label}`}</div>
      {props.children}
    </div>
  );
}

function PageA(props: { title?: string }) {
  const { data } = useQuery("/page-a" as any);
  return <div>{`page-a:${props.title}:${(data as any).value}`}</div>;
}

function PageB(props: { title?: string }) {
  const { data } = useQuery("/page-b" as any);
  return <div>{`page-b:${props.title}:${(data as any).value}`}</div>;
}

const componentTree: ComponentTree = [
  ["Layout", [["PageA", []], ["PageB", []]]] as any,
];

const viewImportMap = { Layout, PageA, PageB } as any;

function App() {
  const [route, setRoute] = useState({
    pathname: "/a",
    entries: ["Layout", "PageA"],
    // What the router does on every navigation: the layout's props come from
    // the new payload, so its content changes alongside the leaf swap.
    data: { "/a": { Layout: { label: "for-a" }, PageA: { title: "A" } } },
  });
  (App as any).navigate = (next: typeof route) => setRoute(next);

  return (
    <QueryManagerProvider>
      <ComponentsProvider viewImportMap={viewImportMap}>
        <RouteStateProvider
          state={{ data: route.data } as unknown as RouteState & PageData}
        >
          <Tree
            action={null as any}
            tree={componentTree}
            entries={route.entries}
            pathname={route.pathname}
          />
        </RouteStateProvider>
      </ComponentsProvider>
    </QueryManagerProvider>
  );
}

function createFetch() {
  const pending = new Map<string, Array<(body: any) => void>>();
  const fetchMock = vi.fn((url: string) => {
    return new Promise((resolve) => {
      const list = pending.get(url) ?? [];
      list.push((body) =>
        resolve({ ok: true, status: 200, json: async () => body } as Response),
      );
      pending.set(url, list);
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    async resolve(url: string, body: any) {
      const settle = pending.get(url)?.shift();
      if (!settle) throw new Error(`No pending fetch for ${url}`);
      await act(async () => {
        settle(body);
      });
    },
  };
}

let net: ReturnType<typeof createFetch>;

beforeEach(() => {
  net = createFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a leaf swap whose layout content also changes keeps the previous page while the new leaf's query resolves", async () => {
  const screen = render(<App />);
  await net.resolve("/api/page-a", { value: 1 });
  expect(screen.queryByText("layout:for-a")).not.toBeNull();
  expect(screen.queryByText("page-a:A:1")).not.toBeNull();

  await act(async () => {
    startTransition(() => {
      (App as any).navigate({
        pathname: "/b",
        entries: ["Layout", "PageB"],
        data: { "/b": { Layout: { label: "for-b" }, PageB: { title: "B" } } },
      });
    });
  });

  // The bug: the leaf boundary was new, the layout's changed chrome
  // committed, and the outgoing page blanked to the null fallback. With
  // slot-keyed boundaries the transition must hold the whole previous page.
  expect(screen.queryByText("page-a:A:1")).not.toBeNull();
  expect(screen.queryByText("layout:for-a")).not.toBeNull();

  await net.resolve("/api/page-b", { value: 2 });

  expect(screen.queryByText("layout:for-b")).not.toBeNull();
  expect(screen.queryByText("page-b:B:2")).not.toBeNull();
  expect(screen.queryByText("page-a:A:1")).toBeNull();
});

test("swapping back to a cached leaf commits synchronously", async () => {
  const screen = render(<App />);
  await net.resolve("/api/page-a", { value: 1 });

  await act(async () => {
    startTransition(() => {
      (App as any).navigate({
        pathname: "/b",
        entries: ["Layout", "PageB"],
        data: { "/b": { Layout: { label: "for-b" }, PageB: { title: "B" } } },
      });
    });
  });
  await net.resolve("/api/page-b", { value: 2 });
  expect(screen.queryByText("page-b:B:2")).not.toBeNull();

  // Both queries are now cached: navigating back must not suspend at all.
  await act(async () => {
    startTransition(() => {
      (App as any).navigate({
        pathname: "/a",
        entries: ["Layout", "PageA"],
        data: { "/a": { Layout: { label: "for-a" }, PageA: { title: "A" } } },
      });
    });
  });

  expect(screen.queryByText("page-a:A:1")).not.toBeNull();
  expect(screen.queryByText("layout:for-a")).not.toBeNull();
});
