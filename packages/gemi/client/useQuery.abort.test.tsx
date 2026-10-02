/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, Suspense, act, useState } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { QueryResource } from "./QueryResource";
import { useQuery } from "./useQuery";

/**
 * #659: a request whose variant nobody renders any more is aborted, and the
 * abort is never a failure — no error, no retry, the cached data stays.
 */

type Pending = {
  url: string;
  signal?: AbortSignal;
  settle: (body: any) => void;
};

/**
 * A `fetch` stub that honours `signal` the way the browser does: aborting
 * rejects the promise with an `AbortError`.
 */
function createFetch() {
  const pending: Pending[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      const entry: Pending = {
        url,
        signal,
        settle: (body) =>
          resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => body,
          } as Response),
      };
      pending.push(entry);
      signal?.addEventListener("abort", () => {
        pending.splice(pending.indexOf(entry), 1);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    pending,
    signalFor: (url: string) =>
      fetchMock.mock.calls.find(([u]) => u === url)?.[1]?.signal ?? undefined,
    async resolve(url: string, body: any) {
      const entry = pending.find((p) => p.url === url);
      if (!entry) throw new Error(`No pending fetch for ${url}`);
      pending.splice(pending.indexOf(entry), 1);
      await act(async () => {
        entry.settle(body);
      });
    },
  };
}

/** Let the deferred abort (a 0ms task) and the rejection it causes run. */
async function flushAbort() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

let net: ReturnType<typeof createFetch>;

beforeEach(() => {
  net = createFetch();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("QueryResource aborts", () => {
  test("letting go of the last reader aborts the request, and the abort is not a failure", async () => {
    const resource = new QueryResource("/todos", { "q=a": ["old"] });
    const release = resource.retain("q=a");
    resource.refetch("q=a");
    expect(resource.peek("q=a")?.loading).toBe(true);
    const signal = net.signalFor("/api/todos?q=a")!;

    release();
    await flushAbort();

    expect(signal.aborted).toBe(true);
    const state = resource.peek("q=a")!;
    expect(state.error).toBeFalsy();
    expect(state.data).toEqual(["old"]);
    expect(state.hasData).toBe(true);
    expect(state.loading).toBe(false);
    expect(resource.failureCount("q=a")).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("a variant another reader still renders is not aborted", async () => {
    const resource = new QueryResource("/todos", {});
    const releaseA = resource.retain("q=a");
    const releaseB = resource.retain("q=a");
    resource.getVariant("q=a");
    const signal = net.signalFor("/api/todos?q=a")!;

    releaseA();
    await flushAbort();
    expect(signal.aborted).toBe(false);

    await net.resolve("/api/todos?q=a", ["a"]);
    expect(resource.peek("q=a")?.data).toEqual(["a"]);
    releaseB();
  });

  test("letting go and taking hold again in the same tick never aborts (StrictMode, resubscribe)", async () => {
    const resource = new QueryResource("/todos", {});
    const release = resource.retain("q=a");
    resource.getVariant("q=a");
    const signal = net.signalFor("/api/todos?q=a")!;

    release();
    const again = resource.retain("q=a");
    await flushAbort();

    expect(signal.aborted).toBe(false);
    again();
  });

  test("a request nobody ever held — a prefetch — is left alone", async () => {
    const resource = new QueryResource("/todos", {});
    resource.read("q=a");
    const signal = net.signalFor("/api/todos?q=a")!;
    await flushAbort();
    expect(signal.aborted).toBe(false);
  });

  test("an aborted variant refetches the next time someone reads it", async () => {
    const resource = new QueryResource("/todos", {});
    const release = resource.retain("q=a");
    resource.getVariant("q=a");
    release();
    await flushAbort();
    expect(resource.peek("q=a")).toMatchObject({
      loading: false,
      hasData: false,
      error: undefined,
    });

    resource.getVariant("q=a");
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    await net.resolve("/api/todos?q=a", ["a"]);
    expect(resource.peek("q=a")?.data).toEqual(["a"]);
  });

  test("an abort wakes a reader suspended on the variant, so it can read again", async () => {
    const resource = new QueryResource("/todos", {});
    const { promise } = resource.read("q=a");
    const release = resource.retain("q=a");
    release();
    let woke = false;
    promise!.then(() => {
      woke = true;
    });
    await flushAbort();
    expect(woke).toBe(true);
  });
});

function Providers(props: PropsWithChildren) {
  return (
    <QueryManagerProvider>
      <RouteStateProvider state={{} as RouteState & PageData}>
        <Suspense fallback={<div>fallback</div>}>{props.children}</Suspense>
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

let setQ: (q: string) => void = () => {};

function Search(props: { suspense?: boolean }) {
  const [q, _setQ] = useState("a");
  setQ = _setQ;
  const { data, loading, error } = useQuery(
    "/search" as any,
    { search: { q } },
    { suspense: props.suspense ?? true, retry: 3, retryDelay: 0 },
  );
  return (
    <div>{`data:${JSON.stringify(data ?? null)} loading:${loading} error:${error ? "yes" : "no"}`}</div>
  );
}

describe("useQuery aborts a superseded variant", () => {
  test("suspense + keepPreviousData: a variant changed again before it landed is aborted", async () => {
    const screen = render(
      <Providers>
        <Search />
      </Providers>,
    );
    await net.resolve("/api/search?q=a", "A");
    expect(
      screen.queryByText('data:"A" loading:false error:no'),
    ).not.toBeNull();

    await act(async () => setQ("b"));
    const signalB = net.signalFor("/api/search?q=b")!;
    expect(signalB).toBeDefined();
    expect(screen.queryByText('data:"A" loading:true error:no')).not.toBeNull();

    await act(async () => setQ("c"));
    await flushAbort();

    expect(signalB.aborted).toBe(true);
    // Still showing the previous data, pending, no error surfaced.
    expect(screen.queryByText('data:"A" loading:true error:no')).not.toBeNull();
    expect(screen.queryByText("fallback")).toBeNull();

    await net.resolve("/api/search?q=c", "C");
    expect(
      screen.queryByText('data:"C" loading:false error:no'),
    ).not.toBeNull();
    expect(net.signalFor("/api/search?q=c")!.aborted).toBe(false);
  });

  test("suspense: false: the previous variant's request is aborted without an error or a retry", async () => {
    const screen = render(
      <Providers>
        <Search suspense={false} />
      </Providers>,
    );
    await net.resolve("/api/search?q=a", "A");

    await act(async () => setQ("b"));
    const signalB = net.signalFor("/api/search?q=b")!;
    await act(async () => setQ("c"));
    await flushAbort();

    expect(signalB.aborted).toBe(true);
    expect(screen.queryByText(/error:yes/)).toBeNull();
    await flushAbort();
    // No retry of the aborted variant.
    expect(
      net.fetchMock.mock.calls.filter(([u]) => u === "/api/search?q=b"),
    ).toHaveLength(1);

    await net.resolve("/api/search?q=c", "C");
    expect(
      screen.queryByText('data:"C" loading:false error:no'),
    ).not.toBeNull();
  });

  test("a variant two components share is not aborted while one still renders it", async () => {
    function Both() {
      const [showSecond, setShowSecond] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShowSecond(false)}>
            hide
          </button>
          <Reader id="one" />
          {showSecond && <Reader id="two" />}
        </>
      );
    }
    function Reader(props: { id: string }) {
      const { data } = useQuery(
        "/shared" as any,
        { search: { q: "x" } },
        { suspense: false },
      );
      return <div>{`${props.id}:${JSON.stringify(data ?? null)}`}</div>;
    }

    const screen = render(
      <StrictMode>
        <Providers>
          <Both />
        </Providers>
      </StrictMode>,
    );
    const signal = net.signalFor("/api/shared?q=x")!;
    await act(async () => screen.getByRole("button").click());
    await flushAbort();
    expect(signal.aborted).toBe(false);

    await net.resolve("/api/shared?q=x", "X");
    expect(screen.queryByText('one:"X"')).not.toBeNull();
  });
});
