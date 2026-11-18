/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Suspense, act } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useQuery } from "./useQuery";
import { useMultipleQuery } from "./useMultipleQuery";

/**
 * A `refreshInterval` reload that fires while the variant's first request is
 * still on the wire (#1296). A `suspense: false` reader with nothing cached
 * starts that request silently during render, so the store has no entry for
 * the variant yet: the reload joins the request instead of reading the
 * missing state, and the request's answer serves both.
 */

function createFetch() {
  const pending: Array<(body: unknown) => void> = [];
  const fetchMock = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.push((body) =>
          resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => body,
          } as unknown as Response),
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    async resolve(body: unknown) {
      const settle = pending.shift();
      if (!settle) throw new Error("No pending fetch to resolve");
      await act(async () => settle(body));
    },
  };
}

function Providers(props: PropsWithChildren) {
  return (
    <QueryManagerProvider>
      <RouteStateProvider state={{} as RouteState & PageData}>
        <Suspense fallback={<div>fallback</div>}>{props.children}</Suspense>
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
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refreshInterval shorter than the first response", () => {
  test("useQuery: the reload joins the in-flight first request", async () => {
    const seen: string[] = [];
    function View() {
      const { data, loading } = useQuery(
        "/feed" as any,
        {},
        { suspense: false, refreshInterval: 100 },
      );
      seen.push(`${loading}:${(data as any)?.v}`);
      return null;
    }
    render(<View />, { wrapper: Providers });
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    // Several reloads fire before the first answer: none throws, none races it.
    await advance(350);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    await net.resolve({ v: 1 });
    expect(seen.at(-1)).toBe("false:1");

    // With data cached, the next tick reloads as before.
    await advance(100);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    await net.resolve({ v: 2 });
    expect(seen.at(-1)).toBe("false:2");
  });

  test("useMultipleQuery: the reload joins the in-flight first request", async () => {
    const seen: string[] = [];
    function View() {
      const { data } = useMultipleQuery(
        { feed: ["/feed" as any, {}, { refreshInterval: 100 }] },
        { suspense: false },
      );
      seen.push(`${(data.feed as any)?.v}`);
      return null;
    }
    render(<View />, { wrapper: Providers });
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    await advance(350);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);

    await net.resolve({ v: 1 });
    expect(seen.at(-1)).toBe("1");

    await advance(100);
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    await net.resolve({ v: 2 });
    expect(seen.at(-1)).toBe("2");
  });
});
