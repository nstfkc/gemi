/** @vitest-environment node */
import { afterEach, describe, expect, test, vi } from "vitest";
import { Suspense } from "react";
import { renderToString } from "react-dom/server";

import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import {
  ServerQueryContext,
  type ServerQueriesLike,
  type ServerQueryEntryLike,
} from "./ServerQueryContext";
import { useMultipleQuery } from "./useMultipleQuery";

function renderOnServer(
  ui: React.ReactNode,
  state: Partial<RouteState & PageData> = {},
  serverQueries: ServerQueriesLike | null = null,
) {
  return renderToString(
    <ServerQueryContext.Provider value={serverQueries}>
      <QueryManagerProvider>
        <RouteStateProvider state={state as RouteState & PageData}>
          <Suspense fallback={<div>fallback</div>}>{ui}</Suspense>
        </RouteStateProvider>
      </QueryManagerProvider>
    </ServerQueryContext.Provider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useMultipleQuery during SSR", () => {
  test("renders the prefetched data of every key, matched by path and variant", () => {
    function View() {
      const { data, loading } = useMultipleQuery({
        lists: ["/orgs/:orgId/lists" as any, { params: { orgId: 42 } }],
        page: ["/items" as any, { search: { page: 2 } }],
      });
      return (
        <div>{`${(data.lists as any[]).length}:${(data.page as any[]).length}:${loading}`}</div>
      );
    }
    const html = renderOnServer(<View />, {
      prefetchedData: {
        "/orgs/42/lists": { "": [{ id: 1 }, { id: 2 }] },
        "/items": { "page=2": [{ id: 3 }] },
      },
    });
    expect(html).toContain("2:1:false");
  });

  test("never fetches from the render", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    function View() {
      useMultipleQuery({ a: ["/a" as any] }, { suspense: false });
      return null;
    }
    renderOnServer(<View />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a suspense key without prefetched data warns, naming the missing prefetch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    function View() {
      useMultipleQuery({
        a: ["/a" as any],
        b: ["/b" as any],
      });
      return null;
    }
    renderOnServer(<View />, { prefetchedData: { "/a": { "": 1 } } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('useMultipleQuery("/b")'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Query.prefetch("/b")'),
    );
  });

  test("a streaming render reads every key from the request's store", () => {
    const entries: Record<string, ServerQueryEntryLike> = {
      "/a": { status: "resolved", data: { v: "A" }, promise: Promise.resolve() },
      "/b": { status: "resolved", data: { v: "B" }, promise: Promise.resolve() },
    };
    const ensure = vi.fn((path: string) => entries[path]);
    function View() {
      const { data } = useMultipleQuery({ a: ["/a" as any], b: ["/b" as any] });
      return <div>{`${(data.a as any).v}${(data.b as any).v}`}</div>;
    }
    const html = renderOnServer(<View />, {}, { ensure });
    expect(html).toContain("AB");
  });

  test("a streaming render starts every pending key before it suspends", () => {
    const ensure = vi.fn(
      (): ServerQueryEntryLike => ({
        status: "pending",
        promise: new Promise(() => {}),
      }),
    );
    function View() {
      useMultipleQuery({
        a: ["/a" as any],
        b: ["/b/:id" as any, { params: { id: 7 }, search: { q: "x" } }],
      });
      return <div>rendered</div>;
    }
    const html = renderOnServer(<View />, {}, { ensure });
    expect(html).toContain("fallback");
    expect(ensure.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "/a",
      "/b/:id",
    ]);
    expect(ensure).toHaveBeenCalledWith("/b/:id", {
      params: { id: 7 },
      search: { q: "x" },
    });
  });
});
