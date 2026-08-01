/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Suspense, act, useState } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render } from "@testing-library/react";

import { QueryManagerProvider, type QueryConfig } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useQuery } from "./useQuery";
import { useUser } from "./auth/useUser";

/**
 * Provider-level `queryConfig` (issue #292): app-wide `useQuery` defaults set
 * once where the root is created. Resolution order is per-call config →
 * provider defaults → framework defaults, and framework-internal hooks never
 * see the app's config. The headline acceptance: an app with zero per-call
 * configs and `queryConfig: { suspense: false }` behaves like 0.48 useQuery —
 * the non-suspense assertions from `useQuery.suspense.test.tsx` re-run here
 * under the flag with the per-call config removed.
 */

function createFetch() {
  const pending: Array<(value: { ok: boolean; body: any }) => void> = [];
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
    return new Promise((resolve) => {
      pending.push(({ ok, body }) =>
        resolve({
          ok,
          status: ok ? 200 : 500,
          json: async () => body,
        } as Response),
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

function Providers(
  props: PropsWithChildren<{
    queryConfig?: QueryConfig;
    routeState?: Partial<RouteState & PageData>;
  }>,
) {
  return (
    <QueryManagerProvider queryConfig={props.queryConfig}>
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

let net: ReturnType<typeof createFetch>;

beforeEach(() => {
  net = createFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("queryConfig: { suspense: false } with zero per-call configs", () => {
  test("reproduces the loading-flag sequence", async () => {
    const states: Array<{ data: any; loading: boolean }> = [];
    function View() {
      const { data, loading } = useQuery("/todos" as any);
      states.push({ data, loading });
      return <div>{`loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers queryConfig={{ suspense: false }}>
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
      const { error, loading } = useQuery("/todos" as any);
      return (
        <div>{`error:${(error as any)?.name ?? "none"} loading:${loading}`}</div>
      );
    }

    const screen = render(
      <Providers queryConfig={{ suspense: false }}>
        <View />
      </Providers>,
    );

    await net.resolve({ message: "boom" }, false);

    expect(screen.queryByText("error:QueryError loading:false")).not.toBeNull();
  });

  test("a variant change keeps the previous rows (0.48 keepPreviousData path)", async () => {
    function PagedList() {
      const [page, setPage] = useState(1);
      const { data, loading } = useQuery("/todos" as any, { search: { page } });
      return (
        <button type="button" onClick={() => setPage((p) => p + 1)}>
          {`ids:${((data as any[]) ?? []).map((t: any) => t.id).join(",")} loading:${loading}`}
        </button>
      );
    }

    const screen = render(
      <Providers queryConfig={{ suspense: false }}>
        <PagedList />
      </Providers>,
    );

    await net.resolve([{ id: 1 }]);
    expect(screen.queryByText("ids:1 loading:false")).not.toBeNull();

    await act(async () => {
      screen.getByRole("button").click();
    });

    // No fallback (nothing suspends app-wide) and no empty flash: the
    // previous page's rows stay up while page 2 loads.
    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(screen.queryByText("ids:1 loading:true")).not.toBeNull();

    await net.resolve([{ id: 2 }]);
    expect(screen.queryByText("ids:2 loading:false")).not.toBeNull();
  });
});

describe("per-call config wins over provider defaults", () => {
  test("suspense: true at the call site overrides an app-wide suspense: false", async () => {
    function View() {
      const { data } = useQuery("/todos" as any, {}, { suspense: true });
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers queryConfig={{ suspense: false }}>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("suspense-fallback")).not.toBeNull();

    await net.resolve([{ id: 1 }]);

    expect(screen.queryByText("items:1")).not.toBeNull();
  });

  test("suspense: false at the call site overrides an app-wide suspense: true", async () => {
    function View() {
      const { loading } = useQuery("/todos" as any, {}, { suspense: false });
      return <div>{`loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers queryConfig={{ suspense: true }}>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(screen.queryByText("loading:true")).not.toBeNull();

    await net.resolve([{ id: 1 }]);
    expect(screen.queryByText("loading:false")).not.toBeNull();
  });

  test("a per-call key explicitly set to undefined falls through to the provider default", async () => {
    // The common conditional / prop-forwarding shape: the key is *present*
    // but `undefined`. It must not clobber the provider's `suspense: false`
    // (which would fall through to the framework default and suspend).
    function View() {
      const { loading } = useQuery(
        "/todos" as any,
        {},
        { suspense: undefined as any },
      );
      return <div>{`loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers queryConfig={{ suspense: false }}>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(screen.queryByText("loading:true")).not.toBeNull();

    await net.resolve([{ id: 1 }]);
    expect(screen.queryByText("loading:false")).not.toBeNull();
  });

  test("a provider key explicitly set to undefined falls through to the framework default", async () => {
    // `queryConfig: { suspense: env.SUSPENSE }` with the env value absent:
    // the framework default (suspense: true) must apply.
    function View() {
      const { data } = useQuery("/todos" as any);
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers queryConfig={{ suspense: undefined }}>
        <View />
      </Providers>,
    );

    expect(screen.queryByText("suspense-fallback")).not.toBeNull();

    await net.resolve([{ id: 1 }]);
    expect(screen.queryByText("items:1")).not.toBeNull();
  });

  test("keepPreviousData: true at the call site overrides an app-wide false", async () => {
    function PagedList(props: { config?: Record<string, any> }) {
      const [page, setPage] = useState(1);
      const { data } = useQuery(
        "/todos" as any,
        { search: { page } },
        props.config ?? {},
      );
      return (
        <button type="button" onClick={() => setPage((p) => p + 1)}>
          {`ids:${(data as any[]).map((t: any) => t.id).join(",")}`}
        </button>
      );
    }

    // Provider default `keepPreviousData: false`: a variant change suspends.
    const suspending = render(
      <Providers queryConfig={{ keepPreviousData: false }}>
        <PagedList />
      </Providers>,
    );
    await net.resolve([{ id: 1 }]);
    expect(suspending.queryByText("ids:1")).not.toBeNull();

    await act(async () => {
      suspending.getByRole("button").click();
    });
    expect(suspending.queryByText("suspense-fallback")).not.toBeNull();
    await net.resolve([{ id: 2 }]);
    expect(suspending.queryByText("ids:2")).not.toBeNull();
    suspending.unmount();

    // Same provider default, per-call `keepPreviousData: true`: the previous
    // rows stay committed through the variant change.
    const keeping = render(
      <Providers queryConfig={{ keepPreviousData: false }}>
        <PagedList config={{ keepPreviousData: true }} />
      </Providers>,
    );
    await net.resolve([{ id: 3 }]);
    expect(keeping.queryByText("ids:3")).not.toBeNull();

    await act(async () => {
      keeping.getByRole("button").click();
    });
    expect(keeping.queryByText("suspense-fallback")).toBeNull();
    expect(keeping.queryByText("ids:3")).not.toBeNull();

    await net.resolve([{ id: 4 }]);
    expect(keeping.queryByText("ids:4")).not.toBeNull();
  });
});

describe("numeric provider defaults flow through", () => {
  test("retryIntervalOnError from the provider drives the retry timer", async () => {
    function View() {
      const { error, loading } = useQuery("/todos" as any);
      return (
        <div>{`error:${(error as any)?.name ?? "none"} loading:${loading}`}</div>
      );
    }

    const screen = render(
      <Providers queryConfig={{ suspense: false, retryIntervalOnError: 5 }}>
        <View />
      </Providers>,
    );

    await net.resolve({ message: "boom" }, false);
    expect(screen.queryByText("error:QueryError loading:false")).not.toBeNull();

    // The framework default is 10s; the provider's 5ms retry must fire well
    // within this window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("only app-wide keys pass the provider at runtime", () => {
  test("call-site-only keys smuggled through a non-literal config are dropped", async () => {
    // TS excess-property checking doesn't fire on non-literal values, so this
    // typechecks in user land. `lazy: true` leaking app-wide would stop every
    // unconfigured query from fetching; `fallbackData` would seed every query
    // with the same value.
    const smuggled = {
      suspense: false,
      lazy: true,
      fallbackData: [{ id: 99 }],
    };

    const states: Array<{ data: any; loading: boolean }> = [];
    function View() {
      const { data, loading } = useQuery("/todos" as any);
      states.push({ data, loading });
      return <div>{`loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers queryConfig={smuggled as QueryConfig}>
        <View />
      </Providers>,
    );

    // `suspense: false` (an app-wide key) applies; `lazy` does not — the
    // query fetches on mount — and `fallbackData` does not seed the cache.
    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    expect(states[0]).toEqual({ data: undefined, loading: true });

    await net.resolve([{ id: 1 }]);
    expect(screen.queryByText("loading:false")).not.toBeNull();
    expect(states.at(-1)!.data).toEqual([{ id: 1 }]);
  });
});

describe("framework internals ignore the app's queryConfig", () => {
  test("useUser keeps its own defaults under an aggressive queryConfig", async () => {
    function View() {
      const { user, loading } = useUser();
      return (
        <div>{`user:${(user as any)?.id ?? "none"} loading:${loading}`}</div>
      );
    }

    // `refreshInterval: 5` + `staleTime: 0` would refetch `/auth/me` every
    // few milliseconds if the app config leaked into `useUser`.
    const screen = render(
      <Providers queryConfig={{ refreshInterval: 5, staleTime: 0 }}>
        <View />
      </Providers>,
    );

    // `suspense: false` semantics are pinned inside the hook: no fallback,
    // `user: null` while loading.
    expect(screen.queryByText("suspense-fallback")).toBeNull();
    expect(screen.queryByText("user:none loading:true")).not.toBeNull();

    await net.resolve({ id: "u1" });
    expect(screen.queryByText("user:u1 loading:false")).not.toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });
});
