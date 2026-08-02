/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Component, Suspense, act, useContext } from "react";
import type { PropsWithChildren, ReactNode } from "react";
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
import { QueryError } from "./QueryError";

/**
 * The client half of the suspense contract (`useQuery.ssr.test.tsx` pins the
 * server half): with no cached data the component suspends into the nearest
 * boundary; with data — seeded, hydrated, or prefetched — it renders
 * immediately and never touches `/api`.
 */

function createFetch() {
  const pending: Array<(value: { ok: boolean; body: any }) => void> = [];
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
    return new Promise((resolve) => {
      pending.push(({ ok, body }) =>
        resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response),
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    fetchMock,
    async resolve(body: any, ok = true) {
      const settle = pending.shift();
      if (!settle) throw new Error("No pending fetch to resolve");
      await act(async () => {
        settle({ ok, body });
      });
    },
    pendingCount: () => pending.length,
  };
}

/** Captures the provider's `hydrate` so tests can push a route payload in. */
let hydrateRef: ((data: Record<string, Record<string, any>>) => void) | null =
  null;
function CaptureHydrate() {
  const { hydrate } = useContext(QueryManagerContext);
  hydrateRef = hydrate;
  return null;
}

function Providers(
  props: PropsWithChildren<{ routeState?: Partial<RouteState & PageData> }>,
) {
  return (
    <QueryManagerProvider>
      <CaptureHydrate />
      <RouteStateProvider
        state={(props.routeState ?? {}) as RouteState & PageData}
      >
        <Suspense fallback={<div>suspense-fallback</div>}>
          {props.children}
        </Suspense>
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

class Boundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <div>{`caught:${this.state.error.name}`}</div>;
    }
    return this.props.children;
  }
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

describe("useQuery with suspense (the default)", () => {
  test("an uncached query suspends, then commits the data", async () => {
    function View() {
      const { data, loading } = useQuery("/todos" as any);
      return <div>{`items:${(data as any[]).length} loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("suspense-fallback")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    await net.resolve([{ id: 1 }, { id: 2 }]);

    expect(screen.queryByText("items:2 loading:false")).not.toBeNull();
  });

  test("two siblings on the same path and variant share one fetch", async () => {
    function View(props: { label: string }) {
      const { data } = useQuery("/todos" as any);
      return <div>{`${props.label}:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers>
        <View label="first" />
        <View label="second" />
      </Providers>,
    );

    expect(screen.queryByText("suspense-fallback")).not.toBeNull();

    await net.resolve([{ id: 1 }]);

    expect(screen.queryByText("first:1")).not.toBeNull();
    expect(screen.queryByText("second:1")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("prefetched route data renders immediately — no suspension, no fetch", () => {
    function View() {
      const { data } = useQuery("/todos" as any);
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers
        routeState={{ prefetchedData: { "/todos": { "": [{ id: 1 }] } } }}
      >
        <View />
      </Providers>,
    );

    expect(screen.queryByText("items:1")).not.toBeNull();
    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("a route payload hydrated mid-suspension commits without the fetch", async () => {
    function View() {
      const { data } = useQuery("/todos" as any);
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );
    expect(screen.queryByText("suspense-fallback")).not.toBeNull();

    // The navigation payload lands (Link prefetch → hydrate) while the
    // component is suspended on its own request.
    await act(async () => {
      hydrateRef!({ "/todos": { "": [{ id: 1 }, { id: 2 }, { id: 3 }] } });
    });

    expect(screen.queryByText("items:3")).not.toBeNull();
    // Its own request is still on the wire — the payload answered first.
    expect(net.pendingCount()).toBe(1);
  });

  test("variants suspend independently", async () => {
    function View() {
      const { data } = useQuery("/todos" as any, { search: { page: 2 } });
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers
        routeState={{ prefetchedData: { "/todos": { "": [{ id: 1 }] } } }}
      >
        <View />
      </Providers>,
    );

    // "" is cached but "page=2" is not — the query must not be fooled by the
    // sibling variant.
    expect(screen.queryByText("suspense-fallback")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledWith("/api/todos?page=2", {
      cache: "default",
    });

    await net.resolve([{ id: 2 }]);
    expect(screen.queryByText("items:1")).not.toBeNull();
  });

  test("an HTTP failure reaches the error boundary as a QueryError", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function View() {
      const { data } = useQuery("/todos" as any);
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers>
        <Boundary>
          <View />
        </Boundary>
      </Providers>,
    );

    await net.resolve({ message: "boom" }, false);

    expect(screen.queryByText("caught:QueryError")).not.toBeNull();
  });

  test("lazy queries never suspend and never fetch until triggered", async () => {
    function View() {
      const { data, loading, trigger } = useQuery(
        "/todos" as any,
        {},
        { lazy: true },
      );
      return (
        <button type="button" onClick={() => trigger()}>
          {`items:${(data as any[] | undefined)?.length ?? "none"} loading:${loading}`}
        </button>
      );
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("items:none loading:false")).not.toBeNull();
    expect(net.fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole("button").click();
    });
    await net.resolve([{ id: 1 }]);

    expect(screen.queryByText("items:1 loading:false")).not.toBeNull();
  });
});

describe("useQuery with suspense: false", () => {
  test("reproduces the loading-flag sequence", async () => {
    const states: Array<{ data: any; loading: boolean }> = [];
    function View() {
      const { data, loading } = useQuery(
        "/todos" as any,
        {},
        { suspense: false },
      );
      states.push({ data, loading });
      return <div>{`loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(screen.queryByText("loading:true")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    await net.resolve([{ id: 1 }]);

    expect(screen.queryByText("loading:false")).not.toBeNull();
    expect(states[0]).toEqual({ data: undefined, loading: true });
    expect(states.at(-1)!.data).toEqual([{ id: 1 }]);
  });

  test("an HTTP failure is returned, not thrown", async () => {
    function View() {
      const { error, loading } = useQuery(
        "/todos" as any,
        {},
        { suspense: false },
      );
      return <div>{`error:${(error as any)?.name ?? "none"} loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );

    await net.resolve({ message: "boom" }, false);

    expect(screen.queryByText("error:QueryError loading:false")).not.toBeNull();
  });
});

describe("fallbackData", () => {
  test("seeds the query's own variant, not the variant map (useUser shape)", () => {
    const user = { id: "u1", email: "a@b.c" };
    function View() {
      const { data, loading } = useQuery(
        "/auth/me" as any,
        {},
        { fallbackData: user as any, suspense: false },
      );
      return <div>{`email:${(data as any)?.email} loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("email:a@b.c loading:false")).not.toBeNull();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("under suspense, fallbackData renders without suspending", () => {
    function View() {
      const { data } = useQuery(
        "/todos" as any,
        {},
        { fallbackData: [{ id: 1 }] as any },
      );
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("items:1")).not.toBeNull();
    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });
});

// The QueryError above must also carry what the endpoint said.
test("QueryError exposes the response body and status", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let caught: QueryError | null = null;

  class Catcher extends Component<{ children: ReactNode }, { error: boolean }> {
    state = { error: false };
    static getDerivedStateFromError() {
      return { error: true };
    }
    componentDidCatch(error: Error) {
      caught = error as QueryError;
    }
    render() {
      return this.state.error ? <div>caught</div> : this.props.children;
    }
  }

  function View() {
    const { data } = useQuery("/todos" as any);
    return <div>{(data as any[]).length}</div>;
  }

  render(
    <Providers>
      <Catcher>
        <View />
      </Catcher>
    </Providers>,
  );

  await net.resolve({ message: "boom" }, false);

  expect(caught).toBeInstanceOf(QueryError);
  expect(caught!.status).toBe(500);
  expect(caught!.body).toEqual({ message: "boom" });
  expect(caught!.path).toBe("/todos");
});
