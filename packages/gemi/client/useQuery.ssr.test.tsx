/** @vitest-environment node */
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";

import { QueryManagerProvider } from "./QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useQuery } from "./useQuery";

/**
 * These render on the server, where `window` is undefined — the same conditions
 * as `renderToString` in a real request. `resolveVariant` bails out there, so
 * whatever `useQuery` seeds its state with is what the markup is built from.
 */
function renderWithRouteState(
  ui: React.ReactNode,
  state: Partial<RouteState & PageData> = {},
) {
  return renderToString(
    <QueryManagerProvider>
      <RouteStateProvider state={state as RouteState & PageData}>
        {ui}
      </RouteStateProvider>
    </QueryManagerProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useQuery during SSR", () => {
  test("an uncached query yields `undefined`, so destructuring defaults apply", () => {
    function View() {
      // The idiomatic list pattern: the default only fires on `undefined`, so a
      // `null` seed would make this throw in `renderToString`.
      const { data: items = [], loading } = useQuery("/uncached" as any);
      return <div>{`${items.length}:${loading}`}</div>;
    }

    expect(renderWithRouteState(<View />)).toContain("0:true");
  });

  test("a prefetched query renders the server's data instead of a loading state", () => {
    function View() {
      const { data: items = [], loading } = useQuery("/lists" as any);
      return <div>{`${items.length}:${loading}`}</div>;
    }

    const html = renderWithRouteState(<View />, {
      // What `Query.prefetch` puts on the page: keyed by resolved path, then by
      // the query's variant (sorted search params, empty when there are none).
      prefetchedData: { "/lists": { "": [{ id: 1 }, { id: 2 }] } },
    });

    expect(html).toContain("2:false");
  });

  test("prefetched data is matched by search-param variant", () => {
    function View() {
      const { data: items = [] } = useQuery("/lists" as any, {
        search: { page: "2" },
      });
      return <div>{`${items.length}`}</div>;
    }

    const html = renderWithRouteState(<View />, {
      prefetchedData: { "/lists": { "page=2": [{ id: 3 }] } },
    });

    expect(html).toContain("1");
  });

  test("route params are applied before the prefetch payload is looked up", () => {
    function View() {
      const { data: items = [] } = useQuery("/orgs/:orgId/lists" as any, {
        params: { orgId: "42" },
      });
      return <div>{`${items.length}`}</div>;
    }

    const html = renderWithRouteState(<View />, {
      prefetchedData: { "/orgs/42/lists": { "": [{ id: 1 }] } },
    });

    expect(html).toContain("1");
  });

  test("no request is made from the render phase", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    function View() {
      const { data: items = [] } = useQuery("/uncached" as any);
      return <div>{items.length}</div>;
    }

    renderWithRouteState(<View />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a suspense query without prefetched data warns, naming the missing prefetch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function View() {
      const { data: items = [] } = useQuery("/uncached" as any);
      return <div>{items.length}</div>;
    }

    renderWithRouteState(<View />);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Query.prefetch("/uncached")'),
    );
  });

  test("a prefetched suspense query does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function View() {
      const { data: items = [] } = useQuery("/lists" as any);
      return <div>{items.length}</div>;
    }

    renderWithRouteState(<View />, {
      prefetchedData: { "/lists": { "": [{ id: 1 }] } },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test("opted-out and lazy queries do not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function View() {
      useQuery("/uncached" as any, {}, { suspense: false });
      useQuery("/uncached" as any, {}, { lazy: true });
      return <div />;
    }

    renderWithRouteState(<View />);

    expect(warn).not.toHaveBeenCalled();
  });
});
