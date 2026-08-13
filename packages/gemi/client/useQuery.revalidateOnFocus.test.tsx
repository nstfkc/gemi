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

/**
 * `revalidateOnFocus`: bringing the tab back to the foreground revalidates the
 * query. Opt-in per call or app-wide, gated by `staleTime` (so a quick
 * tab-out-and-back is free), and silent — the data on screen never flashes a
 * loading state while the refetch is on the wire.
 *
 * Every test seeds the cache from a route payload so the mount is fetch-free,
 * which leaves the fetch count reading exactly what focus did. Only `Date` is
 * faked, so ageing the cache past `staleTime` is a `setSystemTime` away while
 * promises and effects still run for real.
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

const SEEDED = { prefetchedData: { "/todos": { "": [{ id: 1 }] } } };

function Providers(
  props: PropsWithChildren<{
    queryConfig?: QueryConfig;
    routeState?: Partial<RouteState & PageData>;
  }>,
) {
  return (
    <QueryManagerProvider queryConfig={props.queryConfig}>
      <RouteStateProvider
        state={(props.routeState ?? SEEDED) as RouteState & PageData}
      >
        <Suspense fallback={<div>suspense-fallback</div>}>
          {props.children}
        </Suspense>
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

/** jsdom always reports "visible"; tests that need the hidden case swap it. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

/**
 * Age the cache past the default `staleTime` (5s) — and, with the same tick,
 * past the default `focusThrottleInterval` (5s).
 */
function ageCache(ms = 10_000) {
  vi.setSystemTime(Date.now() + ms);
}

async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

async function blurWindow() {
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
  });
}

/** The whole gesture the feature is named after: leave, come back. */
async function leaveAndReturn() {
  await blurWindow();
  await focusWindow();
}

async function fireVisibilityChange() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

let net: ReturnType<typeof createFetch>;

beforeEach(() => {
  net = createFetch();
  vi.useFakeTimers({ toFake: ["Date"] });
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("revalidateOnFocus", () => {
  test("off by default: a focus event never touches the wire", async () => {
    function View() {
      const { data } = useQuery("/todos" as any);
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );
    expect(screen.queryByText("items:1")).not.toBeNull();
    ageCache();

    await leaveAndReturn();
    await fireVisibilityChange();

    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("enabled: focus revalidates without dropping the rendered data", async () => {
    function View() {
      const { data, loading } = useQuery(
        "/todos" as any,
        {},
        { revalidateOnFocus: true },
      );
      return <div>{`items:${(data as any[]).length} loading:${loading}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );
    expect(net.fetchMock).not.toHaveBeenCalled();
    ageCache();

    await leaveAndReturn();

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    // Silent: the seeded rows stay on screen while the refetch is in flight.
    expect(screen.queryByText("items:1 loading:false")).not.toBeNull();

    await net.resolve([{ id: 1 }, { id: 2 }]);

    expect(screen.queryByText("items:2 loading:false")).not.toBeNull();
  });

  test("a visibilitychange back to visible revalidates too; hidden does not", async () => {
    function View() {
      const { data } = useQuery(
        "/todos" as any,
        {},
        { revalidateOnFocus: true },
      );
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    render(
      <Providers>
        <View />
      </Providers>,
    );
    ageCache();

    // Leaving the tab is not a return to the foreground.
    setVisibility("hidden");
    await fireVisibilityChange();
    expect(net.fetchMock).not.toHaveBeenCalled();

    setVisibility("visible");
    await fireVisibilityChange();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("staleTime gates it: data still fresh is left alone", async () => {
    function View() {
      const { data } = useQuery(
        "/todos" as any,
        {},
        { revalidateOnFocus: true },
      );
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    render(
      <Providers>
        <View />
      </Providers>,
    );

    // No time passes, so the seeded data is inside its freshness window.
    await leaveAndReturn();
    expect(net.fetchMock).not.toHaveBeenCalled();

    ageCache();
    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a lazy query that was never triggered stays untouched", async () => {
    function View() {
      const { data, loading } = useQuery(
        "/other" as any,
        {},
        { lazy: true, staleTime: 0, revalidateOnFocus: true },
      );
      return (
        <div>{`items:${data ? (data as any[]).length : "none"} loading:${loading}`}</div>
      );
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );
    expect(net.fetchMock).not.toHaveBeenCalled();

    await leaveAndReturn();

    expect(net.fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("items:none loading:false")).not.toBeNull();
  });

  test("the provider-level queryConfig turns it on app-wide", async () => {
    function View() {
      const { data } = useQuery("/todos" as any);
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    render(
      <Providers queryConfig={{ revalidateOnFocus: true }}>
        <View />
      </Providers>,
    );
    ageCache();

    await leaveAndReturn();

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a per-call revalidateOnFocus: false wins over the provider default", async () => {
    function View() {
      const { data } = useQuery(
        "/todos" as any,
        {},
        { revalidateOnFocus: false },
      );
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    render(
      <Providers queryConfig={{ revalidateOnFocus: true }}>
        <View />
      </Providers>,
    );
    ageCache();

    await leaveAndReturn();

    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("silent even for a variant sitting on a failed fetch", async () => {
    let rerender: (() => void) | null = null;
    function View() {
      // A non-silent fetch writes `loading: true` into the cache without
      // notifying subscribers, so the flip only shows up on the next render
      // the component performs for any other reason — this is that render.
      const [, bump] = useState(0);
      rerender = () => bump((n) => n + 1);
      const { data, loading, error } = useQuery(
        "/other" as any,
        {},
        { suspense: false, revalidateOnFocus: true },
      );
      return (
        <div>
          {`items:${data ? (data as any[]).length : "none"} loading:${loading} err:${error ? "yes" : "no"}`}
        </div>
      );
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );
    // The first load fails, leaving a variant with an error and no data.
    await net.resolve({ message: "boom" }, false);
    expect(
      screen.queryByText("items:none loading:false err:yes"),
    ).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    ageCache();
    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);

    // The retry is on the wire; the rendered state is exactly what it was.
    await act(async () => rerender!());
    expect(
      screen.queryByText("items:none loading:false err:yes"),
    ).not.toBeNull();

    await net.resolve([{ id: 1 }]);
    expect(screen.queryByText("items:1 loading:false err:no")).not.toBeNull();
  });

  test("prefetch() does not enrol a lazy query; trigger() does", async () => {
    let controls: { prefetch: () => void; trigger: () => void } | null = null;
    function View() {
      const { data, prefetch, trigger } = useQuery(
        "/other" as any,
        {},
        { lazy: true, revalidateOnFocus: true },
      );
      controls = { prefetch, trigger };
      return <div>{`items:${data ? (data as any[]).length : "none"}`}</div>;
    }

    render(
      <Providers>
        <View />
      </Providers>,
    );

    // A hover prefetch is "fetch once" — data the user may never look at.
    await act(async () => controls!.prefetch());
    await net.resolve([{ id: 1 }]);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    ageCache();
    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    // Triggering it puts the data on screen, and from then on it revalidates.
    await act(async () => controls!.trigger());
    ageCache();
    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a focus with nothing to return from is ignored", async () => {
    function View() {
      const { data } = useQuery(
        "/todos" as any,
        {},
        { revalidateOnFocus: true },
      );
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    render(
      <Providers>
        <View />
      </Providers>,
    );
    ageCache();

    // A dismissed `alert()` or a closed devtools pane: `focus` without the
    // window ever having lost it.
    await focusWindow();
    expect(net.fetchMock).not.toHaveBeenCalled();

    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("focusThrottleInterval spaces out repeated returns", async () => {
    function View() {
      const { data } = useQuery(
        "/todos" as any,
        {},
        { staleTime: 0, revalidateOnFocus: true },
      );
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    render(
      <Providers>
        <View />
      </Providers>,
    );
    // `staleTime: 0` — every read is stale, so the throttle is the only guard.
    ageCache();

    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    await net.resolve([{ id: 1 }]);

    // Clicking in and out of an embedded iframe: blur/focus pairs, no time
    // passing. The throttle absorbs them.
    await leaveAndReturn();
    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    // Past the interval, the next return revalidates again.
    ageCache(6000);
    await leaveAndReturn();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("unmounting removes the listeners", async () => {
    function View() {
      const { data } = useQuery(
        "/todos" as any,
        {},
        { revalidateOnFocus: true },
      );
      return <div>{`items:${(data as any[]).length}`}</div>;
    }

    const screen = render(
      <Providers>
        <View />
      </Providers>,
    );
    ageCache();

    screen.unmount();
    await leaveAndReturn();
    await fireVisibilityChange();

    expect(net.fetchMock).not.toHaveBeenCalled();
  });
});
