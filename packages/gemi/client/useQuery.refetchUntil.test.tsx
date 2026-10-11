/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Suspense, act, useState } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useQuery } from "./useQuery";

/**
 * `refetchUntil` is read from the current render after every commit (#902):
 * a predicate that depends on props or state restarts a stopped poll or
 * cancels a pending one when that state changes, without a mirror ref.
 *
 * The cache is seeded from a route payload, so the fetch count reads exactly
 * what the poll did. Timers are faked; fetches resolve by hand.
 */

function createFetch() {
  const pending: Array<(body: any) => void> = [];
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
    return new Promise((resolve) => {
      pending.push((body) =>
        resolve({ ok: true, status: 200, json: async () => body } as Response),
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    async resolve(body: any) {
      const settle = pending.shift();
      if (!settle) throw new Error("No pending fetch to resolve");
      await act(async () => {
        settle(body);
      });
    },
  };
}

function Providers(props: PropsWithChildren<{ active?: boolean }>) {
  const seeded = {
    prefetchedData: { "/job": { "": { active: props.active ?? false } } },
  };
  return (
    <QueryManagerProvider>
      <RouteStateProvider state={seeded as unknown as RouteState & PageData}>
        <Suspense fallback={<div>suspense-fallback</div>}>
          {props.children}
        </Suspense>
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

let net: ReturnType<typeof createFetch>;

beforeEach(() => {
  net = createFetch();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let setBuilding: (value: boolean) => void = () => {};
let bump: () => void = () => {};

function View(props: {
  predicate?: (data: any, building: boolean, duration: number) => number;
}) {
  const [building, set] = useState(false);
  const [, setTick] = useState(0);
  setBuilding = set;
  bump = () => setTick((n) => n + 1);
  const predicate =
    props.predicate ??
    ((data: any, b: boolean) => (data.active || b ? 1_000 : 0));
  const { data } = useQuery(
    "/job" as any,
    {},
    {
      refetchUntil: (d: any, duration: number) =>
        predicate(d, building, duration),
    },
  );
  return <div>{`active:${(data as any).active}`}</div>;
}

describe("refetchUntil", () => {
  test("polls while the data says so and stops when it doesn't", async () => {
    render(
      <Providers active>
        <View predicate={(d) => (d.active ? 1_000 : 0)} />
      </Providers>,
    );
    await advance(1_000);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    await net.resolve({ active: true });
    await advance(1_000);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    await net.resolve({ active: false });
    await advance(5_000);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("restarts a stopped poll when the state it reads changes", async () => {
    render(
      <Providers>
        <View />
      </Providers>,
    );
    await advance(5_000);
    expect(net.fetchMock).not.toHaveBeenCalled();

    await act(async () => setBuilding(true));
    await advance(999);
    expect(net.fetchMock).not.toHaveBeenCalled();
    await advance(1);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    await net.resolve({ active: false });
    await advance(1_000);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("cancels a pending poll when the state it reads says stop", async () => {
    render(
      <Providers>
        <View />
      </Providers>,
    );
    await act(async () => setBuilding(true));
    await advance(500);
    await act(async () => setBuilding(false));
    await advance(5_000);
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("re-renders do not push a pending poll back", async () => {
    render(
      <Providers>
        <View />
      </Providers>,
    );
    await act(async () => setBuilding(true));
    for (let i = 0; i < 4; i++) {
      await advance(300);
      await act(async () => bump());
    }
    // 1_200ms in: the poll scheduled at 0 fired at 1_000.
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("never schedules a second poll while one is on the wire", async () => {
    render(
      <Providers>
        <View />
      </Providers>,
    );
    await act(async () => setBuilding(true));
    await advance(1_000);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      await act(async () => bump());
      await advance(1_000);
    }
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    await net.resolve({ active: true });
    await advance(1_000);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("hands the last delay back as duration, for backoff", async () => {
    const durations: number[] = [];
    render(
      <Providers>
        <View
          predicate={(_d, building, duration) => {
            if (!building) return 0;
            durations.push(duration);
            return duration ? duration * 2 : 1_000;
          }}
        />
      </Providers>,
    );
    await act(async () => setBuilding(true));
    await advance(1_000);
    await net.resolve({ active: false });
    await advance(2_000);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    await net.resolve({ active: false });
    await advance(3_999);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(net.fetchMock).toHaveBeenCalledTimes(3);
    expect(durations.slice(0, 3)).toEqual([0, 1_000, 2_000]);
  });
});
