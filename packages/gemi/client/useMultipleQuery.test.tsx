/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { Component, Suspense, act, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";
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
 * `useMultipleQuery` (#1251): n queries in one render cycle. The render
 * counts below are pinned against n `useQuery` calls in one component, which
 * suspend one after the other (a request waterfall, 2n + 1 renders) or, with
 * `suspense: false`, render once per answer (n + 1).
 */

function createFetch() {
  const pending = new Map<
    string,
    (body: unknown, status?: number) => void
  >();
  const fetchMock = vi.fn(
    (url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.set(url, (body, status = 200) =>
          resolve({
            ok: status < 400,
            status,
            headers: new Headers(),
            json: async () => body,
          } as unknown as Response),
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    pending,
    urls: () => [...pending.keys()],
    async resolve(url: string, body: unknown, status = 200) {
      const settle = pending.get(url);
      if (!settle) {
        throw new Error(`No pending fetch for ${url} (have ${this.urls()})`);
      }
      pending.delete(url);
      await act(async () => settle(body, status));
    },
    /** Answer every request on the wire, oldest first, until none is left. */
    async drain(body: (url: string) => unknown = (url) => ({ url })) {
      for (let guard = 0; guard < 50 && pending.size; guard++) {
        const [url] = pending.keys();
        await this.resolve(url, body(url));
      }
    },
  };
}

function Providers(
  props: PropsWithChildren<{ routeState?: Partial<RouteState & PageData> }>,
) {
  return (
    <QueryManagerProvider>
      <RouteStateProvider
        state={(props.routeState ?? {}) as RouteState & PageData}
      >
        <Suspense fallback={<div>fallback</div>}>{props.children}</Suspense>
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function spec(n: number, config: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`k${i}`, [`/q${i}`, {}, config]]),
  ) as any;
}

describe("render counts", () => {
  for (const n of [2, 3, 5]) {
    test(`suspense: ${n} useQuery calls take ${2 * n + 1} renders and a waterfall; useMultipleQuery takes 3 and fetches in parallel`, async () => {
      const before = createFetch();
      let renders = 0;
      function Many() {
        renders++;
        for (let i = 0; i < n; i++) useQuery(`/q${i}` as any);
        return <div>many</div>;
      }
      const a = render(<Many />, { wrapper: Providers });
      // Only the first request is on the wire: the others wait behind it.
      expect(before.pending.size).toBe(1);
      await before.drain();
      expect(a.queryByText("many")).not.toBeNull();
      expect(renders).toBe(2 * n + 1);
      cleanup();
      vi.unstubAllGlobals();

      const after = createFetch();
      renders = 0;
      function One() {
        renders++;
        useMultipleQuery(spec(n));
        return <div>one</div>;
      }
      const b = render(<One />, { wrapper: Providers });
      expect(after.pending.size).toBe(n);
      await after.drain();
      expect(b.queryByText("one")).not.toBeNull();
      // One suspended attempt, React's prerender of the suspended tree, and
      // the commit: the same as a single `useQuery`.
      expect(renders).toBe(3);
    });

    test(`suspense: false: ${n} useQuery calls take ${n + 1} renders; useMultipleQuery takes 2`, async () => {
      const before = createFetch();
      let renders = 0;
      function Many() {
        renders++;
        for (let i = 0; i < n; i++) {
          useQuery(`/q${i}` as any, {}, { suspense: false });
        }
        return null;
      }
      render(<Many />, { wrapper: Providers });
      await before.drain();
      expect(renders).toBe(n + 1);
      cleanup();
      vi.unstubAllGlobals();

      const after = createFetch();
      const seen: string[] = [];
      function One() {
        const { data, loading } = useMultipleQuery(spec(n), {
          suspense: false,
        });
        seen.push(`${loading}:${Object.values(data).filter(Boolean).length}`);
        return null;
      }
      render(<One />, { wrapper: Providers });
      await after.drain();
      // Loading with nothing, then everything at once.
      expect(seen).toEqual(["true:0", `false:${n}`]);
    });
  }
});

describe("useMultipleQuery", () => {
  test("returns data, error and loading per key", async () => {
    const net = createFetch();
    function View() {
      const { data, loading, error } = useMultipleQuery({
        products: ["/products" as any],
        category: [
          "/categories/:categoryId" as any,
          { params: { categoryId: 1 } },
        ],
      });
      return (
        <div>{`${(data.products as any).name},${(data.category as any).name},${loading},${error.products},${error.category}`}</div>
      );
    }
    const screen = render(<View />, { wrapper: Providers });
    expect(net.urls().sort()).toEqual(["/api/categories/1", "/api/products"]);
    await net.resolve("/api/products", { name: "p" });
    // Still suspended: the category has not answered yet.
    expect(screen.queryByText("fallback")).not.toBeNull();
    await net.resolve("/api/categories/1", { name: "c" });
    expect(screen.queryByText("p,c,false,null,null")).not.toBeNull();
  });

  test("shares the cache and the request with useQuery", async () => {
    const net = createFetch();
    function Single() {
      const { data } = useQuery("/products" as any);
      return <div>{`single:${(data as any).n}`}</div>;
    }
    let mutateProducts: (fn: any) => void = () => {};
    function Multi() {
      const { data, mutate } = useMultipleQuery({
        products: ["/products" as any],
        user: ["/me" as any],
      });
      mutateProducts = mutate.products;
      return <div>{`multi:${(data.products as any).n}`}</div>;
    }
    const screen = render(
      <>
        <Single />
        <Multi />
      </>,
      { wrapper: Providers },
    );
    // One request for `/products`, whichever hook asked first.
    expect(net.urls().sort()).toEqual(["/api/me", "/api/products"]);
    await net.resolve("/api/products", { n: 1 });
    await net.resolve("/api/me", {});
    expect(screen.queryByText("single:1")).not.toBeNull();
    expect(screen.queryByText("multi:1")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);

    // A mutate through one key updates every reader of that query.
    await act(async () => mutateProducts((d: any) => ({ n: d.n + 1 })));
    expect(screen.queryByText("single:2")).not.toBeNull();
    expect(screen.queryByText("multi:2")).not.toBeNull();
  });

  test("a mutate on one key updates it and refetches only it", async () => {
    const net = createFetch();
    let api: any;
    let renders = 0;
    function View() {
      renders++;
      api = useMultipleQuery({
        a: ["/a" as any],
        b: ["/b" as any],
      });
      return <div>{`${api.data.a.v},${api.data.b.v}`}</div>;
    }
    const screen = render(<View />, { wrapper: Providers });
    await net.drain(() => ({ v: 1 }));
    expect(screen.queryByText("1,1")).not.toBeNull();
    const rendersBefore = renders;

    await act(async () => api.mutate.a({ v: 2 }));
    expect(screen.queryByText("2,1")).not.toBeNull();
    // The optimistic write is one render; the refetch goes out for `a` only.
    expect(renders).toBe(rendersBefore + 1);
    expect(net.urls()).toEqual(["/api/a"]);
    await net.resolve("/api/a", { v: 3 });
    expect(screen.queryByText("3,1")).not.toBeNull();

    // A bare call refetches.
    await act(async () => api.refetch.b());
    expect(net.urls()).toEqual(["/api/b"]);
  });

  test("a mutate is not held back while another key loads its new variant", async () => {
    const net = createFetch();
    let api: any;
    let setPage: (page: number) => void = () => {};
    function View() {
      const [page, set] = useState(1);
      setPage = set;
      api = useMultipleQuery(
        {
          a: ["/a" as any],
          list: ["/list" as any, { search: { page } }, { keepPreviousData: false }],
        },
        { suspense: false },
      );
      return <div>{`a:${api.data.a?.v}`}</div>;
    }
    const screen = render(<View />, { wrapper: Providers });
    await net.drain(() => ({ v: 1 }));
    await act(async () => setPage(2));
    expect(net.urls()).toEqual(["/api/list?page=2"]);
    await act(async () => api.mutate.a({ v: 2 }));
    // `list` is still waiting for page 2; `a` updates anyway.
    expect(screen.queryByText("a:2")).not.toBeNull();
  });

  test("suspense: false returns each key's error; the others still render", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const net = createFetch();
    const seen: string[] = [];
    function View() {
      const { data, error, loading } = useMultipleQuery(
        { ok: ["/ok" as any], bad: ["/bad" as any] },
        { suspense: false, retry: false },
      );
      seen.push(
        `${loading}|${(data.ok as any)?.v}|${(error.bad as any)?.status}|${error.ok}`,
      );
      return null;
    }
    render(<View />, { wrapper: Providers });
    await net.resolve("/api/bad", { message: "nope" }, 404);
    await net.resolve("/api/ok", { v: 1 });
    expect(seen).toEqual(["true|undefined|undefined|null", "false|1|404|null"]);
  });

  test("under suspense a key's error reaches the error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const net = createFetch();
    function View() {
      useMultipleQuery({ ok: ["/ok" as any], bad: ["/bad" as any] });
      return <div>rendered</div>;
    }
    const screen = render(
      <Boundary>
        <View />
      </Boundary>,
      { wrapper: Providers },
    );
    await net.resolve("/api/ok", {});
    await net.resolve("/api/bad", { message: "boom" }, 500);
    expect(screen.queryByText("caught:QueryError")).not.toBeNull();
  });

  test("changing one key's args refetches that key and keeps the previous data meanwhile", async () => {
    const net = createFetch();
    let setId: (id: number) => void = () => {};
    function View() {
      const [id, set] = useState(1);
      setId = set;
      const { data, loading } = useMultipleQuery({
        list: ["/list" as any],
        item: ["/items/:id" as any, { params: { id } }],
      });
      return (
        <div>{`${(data.list as any).v}|${(data.item as any).id}|${loading}`}</div>
      );
    }
    const screen = render(<View />, { wrapper: Providers });
    await net.resolve("/api/list", { v: "L" });
    await net.resolve("/api/items/1", { id: 1 });
    expect(screen.queryByText("L|1|false")).not.toBeNull();

    await act(async () => setId(2));
    // No fallback: the previous item stays while the new one loads.
    expect(screen.queryByText("fallback")).toBeNull();
    expect(screen.queryByText("L|1|true")).not.toBeNull();
    expect(net.urls()).toEqual(["/api/items/2"]);
    await net.resolve("/api/items/2", { id: 2 });
    expect(screen.queryByText("L|2|false")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(3);
  });

  test("suspense: false: a changed search shows the previous data while loading", async () => {
    const net = createFetch();
    let setPage: (page: number) => void = () => {};
    const seen: string[] = [];
    function View() {
      const [page, set] = useState(1);
      setPage = set;
      const { data, loading } = useMultipleQuery(
        {
          list: ["/list" as any, { search: { page } }],
          other: ["/other" as any],
        },
        { suspense: false },
      );
      seen.push(`${(data.list as any)?.page}|${loading}`);
      return null;
    }
    render(<View />, { wrapper: Providers });
    await net.drain((url) => ({ page: url.endsWith("2") ? 2 : 1 }));
    seen.length = 0;
    await act(async () => setPage(2));
    expect(net.urls()).toEqual(["/api/list?page=2"]);
    await net.drain(() => ({ page: 2 }));
    // `useQuery` renders `undefined` first here, then the previous page, then
    // the new one.
    expect(seen).toEqual(["1|true", "2|false"]);
  });

  test("adding a key loads it; removing one drops it", async () => {
    const net = createFetch();
    let setExtra: (on: boolean) => void = () => {};
    function View() {
      const [extra, set] = useState(false);
      setExtra = set;
      const queries: Record<string, any> = { a: ["/a"] };
      if (extra) queries.b = ["/b"];
      const { data } = useMultipleQuery(queries as any);
      return <div>{Object.keys(data).sort().join(",")}</div>;
    }
    const screen = render(<View />, { wrapper: Providers });
    await net.drain();
    expect(screen.queryByText("a")).not.toBeNull();
    await act(async () => setExtra(true));
    await net.drain();
    expect(screen.queryByText("a,b")).not.toBeNull();
    await act(async () => setExtra(false));
    expect(screen.queryByText("a")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("prefetched data renders at once, without a request", () => {
    const net = createFetch();
    function View() {
      const { data, loading } = useMultipleQuery({
        a: ["/a" as any],
        b: ["/b" as any, { search: { q: "x" } }],
      });
      return <div>{`${(data.a as any).v}${(data.b as any).v}${loading}`}</div>;
    }
    const screen = render(
      <Providers
        routeState={{
          prefetchedData: { "/a": { "": { v: 1 } }, "/b": { "q=x": { v: 2 } } },
        }}
      >
        <View />
      </Providers>,
    );
    expect(screen.queryByText("12false")).not.toBeNull();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  test("a key's own config wins over the shared one", async () => {
    const net = createFetch();
    const seen: string[] = [];
    function View() {
      const { data, loading } = useMultipleQuery(
        {
          eager: ["/eager" as any, undefined, { suspense: true }],
          background: ["/background" as any],
        },
        { suspense: false },
      );
      seen.push(`${(data.eager as any)?.v}|${(data.background as any)?.v}|${loading}`);
      return null;
    }
    render(<View />, { wrapper: Providers });
    // `eager` suspends; `background` starts in the same render (#1253).
    expect(seen).toEqual([]);
    expect(net.urls()).toEqual(["/api/eager", "/api/background"]);
    await net.resolve("/api/eager", { v: 1 });
    expect(seen.at(-1)).toBe("1|undefined|true");
    await net.resolve("/api/background", { v: 2 });
    expect(seen.at(-1)).toBe("1|2|false");
  });
});

/**
 * #1253: a key with `suspense: false` starts in the render, so next to a
 * suspending read (in the same hook or another one) all requests of a cold
 * mount go out in one round.
 */
describe("suspense: false keys start in the render", () => {
  test("a non-suspending hook before a suspending one starts all requests before any answer arrives", async () => {
    const net = createFetch();
    const seen: string[] = [];
    function View() {
      const side = useMultipleQuery(
        { c: ["/c" as any], d: ["/d" as any] },
        { suspense: false },
      );
      const main = useMultipleQuery({ a: ["/a" as any], b: ["/b" as any] });
      const data = { ...main.data, ...side.data } as any;
      seen.push(`${data.a.v}${data.b.v}|${data.c?.v}${data.d?.v}`);
      return null;
    }
    render(<View />, { wrapper: Providers });
    // Nothing answered yet, and every request is already on the wire.
    expect(seen).toEqual([]);
    expect(net.urls()).toEqual(["/api/c", "/api/d", "/api/a", "/api/b"]);
    await net.resolve("/api/c", { v: 3 });
    await net.resolve("/api/d", { v: 4 });
    await net.resolve("/api/a", { v: 1 });
    await net.resolve("/api/b", { v: 2 });
    expect(seen.at(-1)).toBe("12|34");
    // One request per key: the mount effects joined the render's.
    expect(net.fetchMock).toHaveBeenCalledTimes(4);
  });

  test("a non-suspending hook after a suspending one waits for it: hook order matters", async () => {
    const net = createFetch();
    function View() {
      useMultipleQuery({ a: ["/a" as any] });
      useMultipleQuery({ c: ["/c" as any] }, { suspense: false });
      return null;
    }
    render(<View />, { wrapper: Providers });
    // The suspending hook throws before the next hook runs.
    expect(net.urls()).toEqual(["/api/a"]);
    await net.resolve("/api/a", { v: 1 });
    expect(net.urls()).toEqual(["/api/c"]);
  });

  test("a suspense: false useQuery before a suspending useMultipleQuery starts in the same render", async () => {
    const net = createFetch();
    function View() {
      const side = useQuery("/side" as any, undefined, { suspense: false });
      const { data } = useMultipleQuery({ a: ["/a" as any] });
      return (
        <div>{`${(data.a as any).v}|${(side.data as any)?.v}|${side.loading}`}</div>
      );
    }
    const screen = render(<View />, { wrapper: Providers });
    expect(net.urls()).toEqual(["/api/side", "/api/a"]);
    await net.resolve("/api/a", { v: 1 });
    expect(screen.queryByText("1|undefined|true")).not.toBeNull();
    await net.resolve("/api/side", { v: 2 });
    expect(screen.queryByText("1|2|false")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a non-suspending key joins the request another reader has on the wire", async () => {
    const net = createFetch();
    function View() {
      const { data } = useMultipleQuery({
        a: ["/shared" as any],
        b: ["/shared" as any, undefined, { suspense: false }],
      });
      return <div>{`${(data.a as any).v}|${(data.b as any)?.v}`}</div>;
    }
    const screen = render(<View />, { wrapper: Providers });
    expect(net.urls()).toEqual(["/api/shared"]);
    await net.resolve("/api/shared", { v: 1 });
    expect(screen.queryByText("1|1")).not.toBeNull();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a lazy reader's trigger joins a request started in another reader's render", async () => {
    const net = createFetch();
    let trigger: () => void = () => {};
    function View() {
      const lazyRead = useQuery("/a" as any, undefined, { lazy: true });
      trigger = lazyRead.trigger;
      const { data } = useMultipleQuery({ a: ["/a" as any] }, { suspense: false });
      return <div>{`${(data.a as any)?.v}|${(lazyRead.data as any)?.v}`}</div>;
    }
    const screen = render(<View />, { wrapper: Providers });
    expect(net.urls()).toEqual(["/api/a"]);
    act(() => trigger());
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    await net.resolve("/api/a", { v: 1 });
    expect(screen.queryByText("1|1")).not.toBeNull();
  });

  test("first answers of non-suspending keys still commit together", async () => {
    const net = createFetch();
    const seen: string[] = [];
    function View() {
      const { data, loading } = useMultipleQuery(
        { a: ["/a" as any], b: ["/b" as any] },
        { suspense: false },
      );
      seen.push(`${(data.a as any)?.v}|${(data.b as any)?.v}|${loading}`);
      return null;
    }
    render(<View />, { wrapper: Providers });
    expect(net.urls()).toEqual(["/api/a", "/api/b"]);
    await net.resolve("/api/a", { v: 1 });
    expect(seen).not.toContain("1|undefined|true");
    await net.resolve("/api/b", { v: 2 });
    expect(seen).toEqual(["undefined|undefined|true", "1|2|false"]);
  });
});

describe("loadingByKey", () => {
  test("each key reports its own loading flag", async () => {
    const net = createFetch();
    const seen: string[] = [];
    function View() {
      const { data, loading, loadingByKey } = useMultipleQuery(
        {
          fast: ["/fast" as any],
          invoices: ["/invoices" as any, undefined, { suspense: false }],
        },
      );
      seen.push(
        `${(data.fast as any).v}|${(data.invoices as any)?.v}|${loading}|${loadingByKey.fast}|${loadingByKey.invoices}`,
      );
      return null;
    }
    render(<View />, { wrapper: Providers });
    await net.resolve("/api/fast", { v: 1 });
    expect(seen.at(-1)).toBe("1|undefined|true|false|true");
    await net.resolve("/api/invoices", { v: 2 });
    expect(seen.at(-1)).toBe("1|2|false|false|false");
  });
});
