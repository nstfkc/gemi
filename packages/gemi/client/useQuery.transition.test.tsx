/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Suspense, act, startTransition, useContext, useState } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render } from "@testing-library/react";

import {
  QueryManagerContext,
  QueryManagerProvider,
} from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useQuery } from "./useQuery";

/**
 * `useQuery` reads through `useSyncExternalStore`, and uSES store updates are
 * always urgent — React cannot keep rendering a transition against a store it
 * knows has changed, so a write that lands mid-transition restarts the pending
 * transition. That is a wasted render, never a wrong UI, and this design keeps
 * the exposure small: render-phase reads never write the store synchronously
 * (silent fetches), and a suspended component was never mounted, so it has no
 * uSES subscription — it is woken by the thrown promise resolving, not by the
 * store.
 *
 * These tests pin the two navigation-shaped consequences on real behavior:
 * a transition into a suspending query keeps the previous page, and a store
 * write during a pending transition updates the visible page without
 * abandoning the navigation.
 */

function createFetch() {
  const pending = new Map<string, Array<(value: { ok: boolean; body: any }) => void>>();
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    return new Promise((resolve) => {
      const list = pending.get(url) ?? [];
      list.push(({ ok, body }) =>
        resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response),
      );
      pending.set(url, list);
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    fetchMock,
    async resolve(url: string, body: any, ok = true) {
      const settle = pending.get(url)?.shift();
      if (!settle) throw new Error(`No pending fetch for ${url}`);
      await act(async () => {
        settle({ ok, body });
      });
    },
  };
}

let hydrateRef:
  | ((data: Record<string, Record<string, any>>) => void)
  | null = null;
function CaptureHydrate() {
  const { hydrate } = useContext(QueryManagerContext);
  hydrateRef = hydrate;
  return null;
}

function Providers(props: PropsWithChildren<{}>) {
  return (
    <QueryManagerProvider>
      <CaptureHydrate />
      <RouteStateProvider state={{} as RouteState & PageData}>
        {props.children}
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

let net: ReturnType<typeof createFetch>;

beforeEach(() => {
  net = createFetch();
});

afterEach(() => {
  cleanup();
  hydrateRef = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The router shape: each segment in its own Suspense, swapped in a transition. */
function Segments(props: { page: "a" | "b" }) {
  return props.page === "a" ? (
    <Suspense fallback={<div>fallback-a</div>}>
      <PageA />
    </Suspense>
  ) : (
    <Suspense fallback={<div>fallback-b</div>}>
      <PageB />
    </Suspense>
  );
}

function PageA() {
  const { data } = useQuery("/page-a" as any);
  return <div>{`page-a:${(data as any).value}`}</div>;
}

function PageB() {
  const { data } = useQuery("/page-b" as any);
  return <div>{`page-b:${(data as any).value}`}</div>;
}

describe("useQuery inside a navigation transition", () => {
  test("a transition into a suspending query keeps the previous page until it resolves", async () => {
    let setPage!: (page: "a" | "b") => void;
    function App() {
      return <Segments page={usePageState((s) => (setPage = s))} />;
    }

    const screen = render(
      <Providers>
        <App />
      </Providers>,
    );
    await net.resolve("/api/page-a", { value: 1 });
    expect(screen.queryByText("page-a:1")).not.toBeNull();

    await act(async () => {
      startTransition(() => setPage("b"));
    });

    // /page-b is uncached: PageB suspended inside the transition. The old
    // page must still be on screen — no fallback, no blank.
    expect(screen.queryByText("page-a:1")).not.toBeNull();
    expect(screen.queryByText("fallback-b")).toBeNull();

    await net.resolve("/api/page-b", { value: 2 });

    expect(screen.queryByText("page-b:2")).not.toBeNull();
    expect(screen.queryByText("page-a:1")).toBeNull();
  });

  test("a store write during a pending transition updates the visible page and the navigation still lands", async () => {
    let setPage!: (page: "a" | "b") => void;
    function App() {
      return <Segments page={usePageState((s) => (setPage = s))} />;
    }

    const screen = render(
      <Providers>
        <App />
      </Providers>,
    );
    await net.resolve("/api/page-a", { value: 1 });
    expect(screen.queryByText("page-a:1")).not.toBeNull();

    await act(async () => {
      startTransition(() => setPage("b"));
    });
    expect(screen.queryByText("page-a:1")).not.toBeNull();

    // While the navigation is pending, /page-a's store updates (e.g. a route
    // payload hydrates it). uSES forces this through urgently — the visible
    // page must re-render with the new value, and the pending transition must
    // survive it.
    await act(async () => {
      hydrateRef!({ "/page-a": { "": { value: 99 } } });
    });
    expect(screen.queryByText("page-a:99")).not.toBeNull();
    expect(screen.queryByText("fallback-b")).toBeNull();

    await net.resolve("/api/page-b", { value: 2 });

    expect(screen.queryByText("page-b:2")).not.toBeNull();
  });

  test("hydrating the suspended query mid-transition commits the navigation without its fetch", async () => {
    let setPage!: (page: "a" | "b") => void;
    function App() {
      return <Segments page={usePageState((s) => (setPage = s))} />;
    }

    const screen = render(
      <Providers>
        <App />
      </Providers>,
    );
    await net.resolve("/api/page-a", { value: 1 });

    await act(async () => {
      startTransition(() => setPage("b"));
    });
    expect(screen.queryByText("page-a:1")).not.toBeNull();

    // The route payload lands (Link prefetch → hydrate) while PageB is
    // suspended — the navigation completes off the payload; PageB's own
    // request is still on the wire.
    await act(async () => {
      hydrateRef!({ "/page-b": { "": { value: 42 } } });
    });

    expect(screen.queryByText("page-b:42")).not.toBeNull();
    expect(screen.queryByText("page-a:1")).toBeNull();
  });
});

function usePageState(expose: (set: (page: "a" | "b") => void) => void) {
  const [page, setPage] = useState<"a" | "b">("a");
  expose(setPage);
  return page;
}
