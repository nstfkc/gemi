/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, Suspense, act } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render, renderHook } from "@testing-library/react";

import { QueryManagerProvider, type QueryConfig } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { ServerDataContext } from "./ServerDataProvider";
import { useQuery } from "./useQuery";
import { useMultipleQuery } from "./useMultipleQuery";
import { useMutation } from "./useMutation";
import { RequestTimeoutError } from "./requestTimeout";
import { isRetryableQueryError } from "./retryPolicy";

/**
 * `timeout` on queries and mutations, and `isReconnecting` (#1273). A request
 * on a weak network can hang with no answer; a timeout aborts it and, for a
 * query, fails it as a retryable network error so `retry` takes over.
 */

type Step = "hang" | "network" | { status: number; body?: unknown };

/**
 * Answers fetches from a script, in order, repeating the last entry. "hang"
 * never answers and rejects only when its signal aborts, like the real fetch.
 */
function createNetwork() {
  let script: Step[] = ["hang"];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const next = script.length > 1 ? script.shift()! : script[0];
    const signal = init?.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    if (next === "network") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    if (next === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }
    return Promise.resolve(
      new Response(JSON.stringify(next.body ?? null), { status: next.status }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    script(...entries: Step[]) {
      script = entries;
    },
    calls: () => fetchMock.mock.calls.length,
    signals: () =>
      fetchMock.mock.calls.map(([, init]) => init?.signal as AbortSignal),
  };
}

function Providers(props: PropsWithChildren<{ queryConfig?: QueryConfig }>) {
  return (
    <ServerDataContext.Provider value={{} as any}>
      <QueryManagerProvider queryConfig={props.queryConfig}>
        <RouteStateProvider state={{} as RouteState & PageData}>
          <Suspense fallback={<div>suspense-fallback</div>}>
            {props.children}
          </Suspense>
        </RouteStateProvider>
      </QueryManagerProvider>
    </ServerDataContext.Provider>
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const LATER = 5 * 60_000;

let net: ReturnType<typeof createNetwork>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  net = createNetwork();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Seen = { data: unknown; error: unknown; loading: boolean; isReconnecting: boolean };

function renderTodos(config: Record<string, unknown>, queryConfig?: QueryConfig) {
  const seen: { current: Seen } = { current: null as unknown as Seen };
  function Todos() {
    const { data, error, loading, isReconnecting } = useQuery(
      "/todos" as any,
      {},
      { suspense: false, ...config } as any,
    );
    seen.current = { data, error, loading, isReconnecting };
    return null;
  }
  render(
    <Providers queryConfig={queryConfig}>
      <Todos />
    </Providers>,
  );
  return seen;
}

describe("query timeout", () => {
  test("without a timeout a hanging request keeps waiting (unchanged)", async () => {
    net.script("hang");
    const seen = renderTodos({});
    await advance(LATER);
    expect(net.calls()).toBe(1);
    expect(net.signals()[0].aborted).toBe(false);
    expect(seen.current.loading).toBe(true);
    expect(seen.current.error).toBeFalsy();
    expect(seen.current.isReconnecting).toBe(false);
  });

  test("past the timeout the request is aborted and fails with a RequestTimeoutError", async () => {
    net.script("hang");
    const seen = renderTodos({ timeout: 2000, retry: false });
    await advance(1999);
    expect(net.signals()[0].aborted).toBe(false);
    await advance(1);

    expect(net.signals()[0].aborted).toBe(true);
    const error = seen.current.error as RequestTimeoutError;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error.name).toBe("TimeoutError");
    expect(error.timeout).toBe(2000);
    expect(error.url).toBe("/api/todos");
    expect(isRetryableQueryError(error)).toBe(true);
    expect(seen.current.loading).toBe(false);
    expect(seen.current.isReconnecting).toBe(false);

    await advance(LATER);
    expect(net.calls()).toBe(1);
  });

  test("retry: true retries a timed-out request, with isReconnecting true until it answers", async () => {
    net.script("hang", "hang", { status: 200, body: ["a"] });
    const seen = renderTodos({ timeout: 1000, retry: true });

    await advance(1000);
    expect(seen.current.error).toBeInstanceOf(RequestTimeoutError);
    expect(seen.current.isReconnecting).toBe(true);

    // First retry after 1s goes out, and hangs for another 1s.
    await advance(1000);
    expect(net.calls()).toBe(2);
    expect(seen.current.isReconnecting).toBe(true);
    await advance(1000);
    expect(seen.current.isReconnecting).toBe(true);

    // Second retry after 2s answers.
    await advance(2000);
    expect(net.calls()).toBe(3);
    expect(seen.current.data).toEqual(["a"]);
    expect(seen.current.error).toBeFalsy();
    expect(seen.current.isReconnecting).toBe(false);
  });

  test("an answer in time clears the timer: nothing is aborted later", async () => {
    net.script({ status: 200, body: ["a"] });
    const seen = renderTodos({ timeout: 1000 });
    await advance(0);
    expect(seen.current.data).toEqual(["a"]);
    await advance(LATER);
    expect(net.signals()[0].aborted).toBe(false);
    expect(seen.current.error).toBeFalsy();
  });

  test("queryConfig.timeout is the app-wide default, and a call site wins", async () => {
    net.script("hang");
    const seen = renderTodos({ retry: false }, { timeout: 500 });
    await advance(500);
    expect((seen.current.error as RequestTimeoutError).timeout).toBe(500);

    cleanup();
    net = createNetwork();
    net.script("hang");
    const second = renderTodos({ retry: false, timeout: 3000 }, { timeout: 500 });
    await advance(500);
    expect(second.current.error).toBeFalsy();
    await advance(2500);
    expect((second.current.error as RequestTimeoutError).timeout).toBe(3000);
  });

  test("useMultipleQuery applies each key's timeout", async () => {
    net.script("hang");
    let seen: any;
    function View() {
      seen = useMultipleQuery(
        { todos: ["/todos" as any] },
        { suspense: false, retry: false, timeout: 800 } as any,
      );
      return null;
    }
    render(
      <Providers>
        <View />
      </Providers>,
    );
    await advance(800);
    expect(seen.error.todos).toBeInstanceOf(RequestTimeoutError);
  });
});

describe("query timeout with several readers of one variant", () => {
  type Reader = { timeout?: number };
  type Handle = { refetch: () => void; error: unknown };

  function renderReaders(readers: Reader[]) {
    const handles: Handle[] = readers.map(() => ({ refetch: () => {}, error: null }));
    function TodosReader(props: { index: number; timeout?: number }) {
      const query = useQuery(
        "/todos" as any,
        {},
        { suspense: false, retry: false, timeout: props.timeout } as any,
      );
      handles[props.index].refetch = query.refetch;
      handles[props.index].error = query.error;
      return null;
    }
    const tree = (shown: boolean[]) => (
      <Providers>
        {readers.map((r, i) =>
          shown[i] ? <TodosReader key={i} index={i} timeout={r.timeout} /> : null,
        )}
      </Providers>
    );
    const all = readers.map(() => true);
    const view = render(tree(all));
    return {
      handles,
      rerender: (shown = all) => view.rerender(tree(shown)),
    };
  }

  for (const order of ["with-timeout first", "without-timeout first"] as const) {
    test(`a reader without a timeout never clears another's (${order})`, async () => {
      net.script("hang");
      const readers: Reader[] =
        order === "with-timeout first" ? [{ timeout: 1000 }, {}] : [{}, { timeout: 1000 }];
      const { handles, rerender } = renderReaders(readers);

      await advance(1000);
      expect(net.calls()).toBe(1);
      expect(net.signals()[0].aborted).toBe(true);
      expect(handles[0].error).toBeInstanceOf(RequestTimeoutError);
      expect(handles[1].error).toBeInstanceOf(RequestTimeoutError);

      // Re-render both, in this order, then send a request from each reader:
      // the timeout still applies, whoever rendered last.
      rerender();
      await advance(0);
      act(() => handles[0].refetch());
      await advance(1000);
      expect(net.calls()).toBe(2);
      expect(net.signals()[1].aborted).toBe(true);

      rerender();
      await advance(0);
      act(() => handles[1].refetch());
      await advance(1000);
      expect(net.calls()).toBe(3);
      expect(net.signals()[2].aborted).toBe(true);
    });
  }

  test("a reader that mounts late gives a long-waiting request its timeout from now, not at once", async () => {
    net.script("hang");
    const { handles, rerender } = renderReaders([{}, { timeout: 1000 }]);
    rerender([true, false]);
    await advance(0);
    act(() => handles[0].refetch());
    await advance(5000);
    const signal = net.signals()[net.calls() - 1];
    expect(signal.aborted).toBe(false);

    rerender([true, true]);
    await advance(0);
    expect(signal.aborted).toBe(false);
    await advance(999);
    expect(signal.aborted).toBe(false);
    await advance(1);
    expect(signal.aborted).toBe(true);
    expect((handles[0].error as RequestTimeoutError).timeout).toBe(1000);
  });

  test("the smallest timeout among mounted readers applies, and an unmounted reader's goes with it", async () => {
    net.script("hang");
    const { handles, rerender } = renderReaders([{ timeout: 3000 }, { timeout: 1000 }, {}]);
    await advance(1000);
    expect((handles[0].error as RequestTimeoutError).timeout).toBe(1000);

    // The 1s reader unmounts: the 3s reader's timeout is what is left.
    rerender([true, false, true]);
    await advance(0);
    act(() => handles[2].refetch());
    await advance(1000);
    expect(net.signals()[1].aborted).toBe(false);
    await advance(2000);
    expect(net.signals()[1].aborted).toBe(true);
    expect((handles[2].error as RequestTimeoutError).timeout).toBe(3000);

    // Only the reader without a timeout is left: requests wait.
    rerender([false, false, true]);
    await advance(0);
    act(() => handles[2].refetch());
    await advance(LATER);
    expect(net.signals()[2].aborted).toBe(false);
  });
});

describe("isReconnecting", () => {
  test("true while a network failure is being retried, false once the retries run out", async () => {
    net.script("network");
    const seen = renderTodos({ retry: 2 });
    await advance(0);
    expect(seen.current.isReconnecting).toBe(true);
    await advance(1000);
    expect(net.calls()).toBe(2);
    expect(seen.current.isReconnecting).toBe(true);
    await advance(2000);
    expect(net.calls()).toBe(3);
    expect(seen.current.isReconnecting).toBe(false);
    await advance(LATER);
    expect(net.calls()).toBe(3);
  });

  test("a retry function runs once per failure, however often the reader re-renders", async () => {
    net.script("network");
    const retry = vi.fn((failureCount: number) => failureCount < 3);
    const seen: { current: Seen } = { current: null as unknown as Seen };
    function Todos(_props: { tick: number }) {
      const { data, error, loading, isReconnecting } = useQuery(
        "/todos" as any,
        {},
        { suspense: false, retry } as any,
      );
      seen.current = { data, error, loading, isReconnecting };
      return null;
    }
    const view = render(
      <Providers>
        <Todos tick={0} />
      </Providers>,
    );
    const rerenders = (from: number) => {
      for (let tick = from; tick < from + 5; tick++) {
        view.rerender(
          <Providers>
            <Todos tick={tick} />
          </Providers>,
        );
      }
    };

    await advance(0);
    expect(net.calls()).toBe(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(seen.current.isReconnecting).toBe(true);
    rerenders(1);
    expect(retry).toHaveBeenCalledTimes(1);

    await advance(1000);
    expect(net.calls()).toBe(2);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenLastCalledWith(2, expect.any(TypeError));
    rerenders(10);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(seen.current.isReconnecting).toBe(true);

    // The third failure: the function gives up.
    await advance(2000);
    expect(net.calls()).toBe(3);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(seen.current.isReconnecting).toBe(false);
    rerenders(20);
    await advance(LATER);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(net.calls()).toBe(3);
    expect(seen.current.isReconnecting).toBe(false);
  });

  test("two readers with different retry policies settle: a retry one schedules keeps it reconnecting", async () => {
    net.script("network", { status: 200, body: ["a"] });
    const seen: Seen[] = [];
    function Todos(props: { index: number; retry: unknown }) {
      const { data, error, loading, isReconnecting } = useQuery(
        "/todos" as any,
        {},
        { suspense: false, retry: props.retry } as any,
      );
      seen[props.index] = { data, error, loading, isReconnecting };
      return null;
    }
    render(
      <Providers>
        <Todos index={0} retry={false} />
        <Todos index={1} retry={true} />
      </Providers>,
    );
    await advance(0);
    expect(net.calls()).toBe(1);
    expect(seen[0].isReconnecting).toBe(true);
    expect(seen[1].isReconnecting).toBe(true);
    await advance(1000);
    expect(net.calls()).toBe(2);
    expect(seen[0].data).toEqual(["a"]);
    expect(seen[0].isReconnecting).toBe(false);
    expect(seen[1].isReconnecting).toBe(false);
  });

  // X has data, a refetch fails and a retry is scheduled; letting go of X
  // cancels it. Coming back to X inside `staleTime` must decide again.
  const RETRY = { suspense: false, retry: true, retryDelay: 1000, staleTime: LATER };

  test("a variant left and come back to (X -> Y -> X) is retried again", async () => {
    net.script(
      { status: 200, body: ["x"] },
      "network",
      { status: 200, body: ["y"] },
      { status: 200, body: ["x2"] },
    );
    let query: any;
    function Todos(props: { q: string }) {
      query = useQuery("/todos" as any, { search: { q: props.q } } as any, RETRY as any);
      return null;
    }
    const view = render(
      <Providers>
        <Todos q="x" />
      </Providers>,
    );
    const show = (q: string) =>
      view.rerender(
        <Providers>
          <Todos q={q} />
        </Providers>,
      );
    await advance(0);
    expect(query.data).toEqual(["x"]);
    act(() => query.refetch());
    await advance(0);
    expect(query.error).toBeInstanceOf(TypeError);
    expect(query.isReconnecting).toBe(true);

    show("y");
    await advance(0);
    expect(query.data).toEqual(["y"]);
    expect(net.calls()).toBe(3);

    show("x");
    await advance(0);
    expect(query.error).toBeInstanceOf(TypeError);
    expect(query.isReconnecting).toBe(true);
    await advance(1000);
    expect(net.calls()).toBe(4);
    expect(query.data).toEqual(["x2"]);
    expect(query.error).toBeFalsy();
    expect(query.isReconnecting).toBe(false);
  });

  test("under StrictMode, a reader mounting on a failed variant schedules its retry", async () => {
    net.script({ status: 200, body: ["a"] }, "network", { status: 200, body: ["b"] });
    let query: any;
    function Todos() {
      query = useQuery("/todos" as any, {}, RETRY as any);
      return null;
    }
    const view = render(
      <Providers>
        <Todos key="first" />
      </Providers>,
    );
    await advance(0);
    act(() => query.refetch());
    await advance(0);
    expect(query.error).toBeInstanceOf(TypeError);

    // The first reader goes, which cancels its retry; a new one mounts under
    // StrictMode, whose double mount lets go of the variant once more.
    view.rerender(<Providers>{null}</Providers>);
    await advance(0);
    view.rerender(
      <Providers>
        <StrictMode>
          <Todos key="second" />
        </StrictMode>
      </Providers>,
    );
    await advance(0);
    expect(query.isReconnecting).toBe(true);
    await advance(1000);
    expect(net.calls()).toBe(3);
    expect(query.data).toEqual(["b"]);
    expect(query.isReconnecting).toBe(false);
  });

  test("useMultipleQuery: a key whose variant goes X -> Y -> X is retried again", async () => {
    net.script(
      { status: 200, body: ["x"] },
      "network",
      { status: 200, body: ["y"] },
      { status: 200, body: ["x2"] },
    );
    let seen: any;
    function View(props: { q: string }) {
      seen = useMultipleQuery(
        { todos: ["/todos" as any, { search: { q: props.q } } as any] },
        RETRY as any,
      );
      return null;
    }
    const view = render(
      <Providers>
        <View q="x" />
      </Providers>,
    );
    const show = (q: string) =>
      view.rerender(
        <Providers>
          <View q={q} />
        </Providers>,
      );
    await advance(0);
    expect(seen.data.todos).toEqual(["x"]);
    act(() => seen.refetch.todos());
    await advance(0);
    expect(seen.error.todos).toBeInstanceOf(TypeError);

    show("y");
    await advance(0);
    expect(seen.data.todos).toEqual(["y"]);

    show("x");
    await advance(0);
    expect(seen.error.todos).toBeInstanceOf(TypeError);
    await advance(1000);
    expect(net.calls()).toBe(4);
    expect(seen.data.todos).toEqual(["x2"]);
    expect(seen.error.todos).toBeFalsy();
  });

  test("false for an error that is never retried", async () => {
    net.script({ status: 404, body: { message: "no" } });
    const seen = renderTodos({});
    await advance(0);
    expect(seen.current.error).toBeTruthy();
    expect(seen.current.isReconnecting).toBe(false);
  });

  test("false with retry: false", async () => {
    net.script("network");
    const seen = renderTodos({ retry: false });
    await advance(0);
    expect(seen.current.error).toBeTruthy();
    expect(seen.current.isReconnecting).toBe(false);
  });
});

describe("mutation timeout", () => {
  function wrapper(queryConfig?: QueryConfig) {
    return ({ children }: PropsWithChildren) => (
      <QueryManagerProvider queryConfig={queryConfig}>{children}</QueryManagerProvider>
    );
  }

  test("past the timeout the request is aborted and onError gets a RequestTimeoutError", async () => {
    net.script("hang");
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useMutation("POST" as never, "/todos" as never, {}, { timeout: 1000, onError }),
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.trigger({} as never);
    });
    await advance(1000);
    await act(async () => {
      await pending;
    });

    expect(net.signals()[0].aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(RequestTimeoutError);
    expect(result.current.error).toBeInstanceOf(RequestTimeoutError);
    expect(result.current.loading).toBe(false);
    await advance(LATER);
    expect(net.calls()).toBe(1);
  });

  test("queryConfig.mutationTimeout is the default", async () => {
    net.script("hang");
    const onError = vi.fn();
    const { result } = renderHook(
      () => useMutation("POST" as never, "/todos" as never, {}, { onError }),
      { wrapper: wrapper({ mutationTimeout: 700 }) },
    );
    act(() => {
      void result.current.trigger({} as never);
    });
    await advance(700);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as RequestTimeoutError).timeout).toBe(700);
  });

  test("without a timeout a hanging mutation keeps waiting, and cancel() is still not an error", async () => {
    net.script("hang");
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useMutation("POST" as never, "/todos" as never, {}, { onError }),
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.trigger({} as never);
    });
    await advance(LATER);
    expect(net.signals()[0].aborted).toBe(false);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      result.current.cancel();
      await pending;
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});
