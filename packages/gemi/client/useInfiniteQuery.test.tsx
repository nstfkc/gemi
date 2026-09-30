/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, Suspense, useState, type PropsWithChildren } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { useInfiniteQuery } from "./useInfiniteQuery";
import { useMutate } from "./useMutate";
import { useQuery } from "./useQuery";

type Row = { id: number };

/** A fetch whose responses the test hands out by URL, in any order. */
function createNetwork() {
  const pending = new Map<string, Array<(body: unknown) => void>>();
  const calls: Array<{ url: string; cache?: RequestCache }> = [];
  const fetchMock = vi.fn(
    (url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        calls.push({ url, cache: init?.cache });
        const queue = pending.get(url) ?? [];
        queue.push((body) =>
          resolve({
            ok: true,
            status: 200,
            json: async () => body,
          } as Response),
        );
        pending.set(url, queue);
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    urls: () => calls.map((c) => c.url),
    async respond(url: string, body: unknown) {
      const settle = pending.get(url)?.shift();
      if (!settle) {
        throw new Error(
          `No pending fetch for ${url}; saw ${JSON.stringify(calls)}`,
        );
      }
      await act(async () => settle(body));
    },
  };
}

function Providers(
  props: PropsWithChildren<{ prefetchedData?: Record<string, unknown> }>,
) {
  return (
    <QueryManagerProvider>
      <RouteStateProvider
        state={
          { prefetchedData: props.prefetchedData ?? {} } as RouteState &
            PageData
        }
      >
        {props.children}
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

const rows = (...ids: number[]): Row[] => ids.map((id) => ({ id }));

/** Pages of two rows: a full page means there may be another. */
const getNextPage = (last: Row[], pages: Row[][]) =>
  last.length === 2 ? pages.length + 1 : null;

function List(props: { search?: Record<string, string | null> }) {
  const { items, hasMore, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      "/items" as any,
      { search: props.search ?? {} },
      {
        suspense: false,
        getNextPage,
        getKey: (row: Row) => row.id,
      },
    );
  return (
    <div>
      <p data-testid="items">{(items as Row[]).map((r) => r.id).join(",")}</p>
      <p data-testid="state">
        {`${hasMore ? "more" : "end"}${isFetchingNextPage ? ":fetching" : ""}`}
      </p>
      <button onClick={fetchNextPage}>next</button>
    </div>
  );
}

const itemsText = () => screen.getByTestId("items").textContent;
const stateText = () => screen.getByTestId("state").textContent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useInfiniteQuery", () => {
  test("page 1 has no page param, later pages add it, and rows are merged", async () => {
    const net = createNetwork();
    render(
      <Providers>
        <List />
      </Providers>,
    );

    await net.respond("/api/items", rows(1, 2));
    expect(itemsText()).toBe("1,2");
    expect(stateText()).toBe("more");

    fireEvent.click(screen.getByText("next"));
    expect(stateText()).toBe("end:fetching");
    await net.respond("/api/items?page=2", rows(3, 4));
    expect(itemsText()).toBe("1,2,3,4");
    expect(stateText()).toBe("more");

    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/items?page=3", rows(5));
    expect(itemsText()).toBe("1,2,3,4,5");
    expect(stateText()).toBe("end");

    // No next page: a no-op, not a request.
    fireEvent.click(screen.getByText("next"));
    expect(net.urls()).toEqual([
      "/api/items",
      "/api/items?page=2",
      "/api/items?page=3",
    ]);
  });

  test("a row that shifted into the next page is shown once, at its first position", async () => {
    const net = createNetwork();
    render(
      <Providers>
        <List />
      </Providers>,
    );
    await net.respond("/api/items", rows(1, 2));
    fireEvent.click(screen.getByText("next"));
    // Something was inserted before row 2 between the two fetches.
    await net.respond("/api/items?page=2", rows(2, 3));
    expect(itemsText()).toBe("1,2,3");
  });

  test("loading another page does not re-read the pages already loaded", async () => {
    const net = createNetwork();
    function Fresh() {
      const { items, fetchNextPage } = useInfiniteQuery(
        "/items" as any,
        {},
        { suspense: false, staleTime: 0, getNextPage },
      );
      return (
        <div>
          <p data-testid="items">
            {(items as Row[]).map((r) => r.id).join(",")}
          </p>
          <button onClick={fetchNextPage}>next</button>
        </div>
      );
    }
    render(
      <Providers>
        <Fresh />
      </Providers>,
    );
    await net.respond("/api/items", rows(1, 2));
    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/items?page=2", rows(3, 4));
    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/items?page=3", rows(5));
    expect(itemsText()).toBe("1,2,3,4,5");
    expect(net.urls()).toEqual([
      "/api/items",
      "/api/items?page=2",
      "/api/items?page=3",
    ]);
  });

  test("fetchNextPage is a no-op while the next page is loading", async () => {
    const net = createNetwork();
    render(
      <Providers>
        <List />
      </Providers>,
    );
    await net.respond("/api/items", rows(1, 2));
    fireEvent.click(screen.getByText("next"));
    fireEvent.click(screen.getByText("next"));
    expect(net.urls()).toEqual(["/api/items", "/api/items?page=2"]);
  });

  test("a search change starts over from page 1 of the new search", async () => {
    const net = createNetwork();
    function Filtered() {
      const [query, setQuery] = useState<string | null>(null);
      return (
        <>
          <button onClick={() => setQuery("b")}>filter</button>
          <List search={{ query }} />
        </>
      );
    }
    render(
      <Providers>
        <Filtered />
      </Providers>,
    );
    await net.respond("/api/items", rows(1, 2));
    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/items?page=2", rows(3, 4));

    fireEvent.click(screen.getByText("filter"));
    // `keepPreviousData`: the previous list stays whole until the new one lands.
    expect(itemsText()).toBe("1,2,3,4");
    expect(stateText()).toBe("end");
    await net.respond("/api/items?query=b", rows(7, 8));
    expect(itemsText()).toBe("7,8");
    expect(stateText()).toBe("more");

    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/items?page=2&query=b", rows(9));
    expect(itemsText()).toBe("7,8,9");
    expect(net.urls()).not.toContain("/api/items?page=3");
  });

  test("pages live in the query cache: a useQuery for page 2 reads it without fetching", async () => {
    const net = createNetwork();
    function PageTwo() {
      const { data } = useQuery(
        "/items" as any,
        { search: { page: 2 } },
        { suspense: false, staleTime: Infinity },
      );
      return <p data-testid="page2">{(data as Row[] | undefined)?.length}</p>;
    }
    function Both() {
      const [show, setShow] = useState(false);
      return (
        <>
          <List />
          <button onClick={() => setShow(true)}>show</button>
          {show ? <PageTwo /> : null}
        </>
      );
    }
    render(
      <Providers>
        <Both />
      </Providers>,
    );
    await net.respond("/api/items", rows(1, 2));
    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/items?page=2", rows(3, 4));

    fireEvent.click(screen.getByText("show"));
    expect(screen.getByTestId("page2").textContent).toBe("2");
    expect(net.urls()).toEqual(["/api/items", "/api/items?page=2"]);
  });

  test("a failed next page is reported, and fetchNextPage retries it", async () => {
    const calls: string[] = [];
    let failPage2 = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/api/items?page=2" && failPage2) {
          failPage2 = false;
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        const body = url === "/api/items" ? rows(1, 2) : rows(3);
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
    function Failing() {
      const { items, error, fetchNextPage } = useInfiniteQuery(
        "/items" as any,
        {},
        { suspense: false, getNextPage },
      );
      return (
        <div>
          <p data-testid="items">
            {(items as Row[]).map((r) => r.id).join(",")}
          </p>
          <p data-testid="error">{error ? "error" : "ok"}</p>
          <button onClick={fetchNextPage}>next</button>
        </div>
      );
    }
    render(
      <Providers>
        <Failing />
      </Providers>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByText("next"));
    await act(async () => {});
    expect(screen.getByTestId("error").textContent).toBe("error");
    expect(itemsText()).toBe("1,2");

    fireEvent.click(screen.getByText("next"));
    await act(async () => {});
    expect(screen.getByTestId("error").textContent).toBe("ok");
    expect(itemsText()).toBe("1,2,3");
    expect(calls).toEqual([
      "/api/items",
      "/api/items?page=2",
      "/api/items?page=2",
    ]);
  });

  test("getItems reads rows out of an object page", async () => {
    const net = createNetwork();
    function Cursor() {
      const { items, hasMore, fetchNextPage } = useInfiniteQuery(
        "/feed" as any,
        {},
        {
          suspense: false,
          pageParam: "cursor",
          getNextPage: (last: { next: string | null }) => last.next,
          getItems: (page: { rows: Row[] }) => page.rows,
        },
      );
      return (
        <div>
          <p data-testid="items">{items.map((r) => r.id).join(",")}</p>
          <p data-testid="state">{hasMore ? "more" : "end"}</p>
          <button onClick={fetchNextPage}>next</button>
        </div>
      );
    }
    render(
      <Providers>
        <Cursor />
      </Providers>,
    );
    await net.respond("/api/feed", { rows: rows(1), next: "abc" });
    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/feed?cursor=abc", { rows: rows(2), next: null });
    expect(itemsText()).toBe("1,2");
    expect(stateText()).toBe("end");
  });

  test("page 1 renders from the prefetch payload under suspense, without a fetch", async () => {
    const net = createNetwork();
    function Suspended() {
      const { items } = useInfiniteQuery(
        "/items" as any,
        { search: { query: "a" } },
        { getNextPage, staleTime: Infinity },
      );
      return (
        <p data-testid="items">{(items as Row[]).map((r) => r.id).join(",")}</p>
      );
    }
    render(
      <Providers prefetchedData={{ "/items": { "query=a": rows(1, 2) } }}>
        <Suspense fallback={<p>fallback</p>}>
          <Suspended />
        </Suspense>
      </Providers>,
    );
    expect(itemsText()).toBe("1,2");
    expect(net.urls()).toEqual([]);
  });
});

describe("useMutate with a search predicate", () => {
  test("updates every cached variant, pages included, and refetches the mounted ones", async () => {
    const net = createNetwork();
    let mutate!: ReturnType<typeof useMutate>;
    function Mutator() {
      mutate = useMutate();
      return null;
    }
    render(
      <Providers>
        <List />
        <Mutator />
      </Providers>,
    );
    await net.respond("/api/items", rows(1, 2));
    fireEvent.click(screen.getByText("next"));
    await net.respond("/api/items?page=2", rows(3, 4));

    act(() => {
      mutate({ path: "/items" as any, search: () => true }, (data: any) =>
        (data as Row[]).filter((row) => row.id !== 3),
      );
    });
    // Optimistic, across both pages.
    expect(itemsText()).toBe("1,2,4");
    // Both pages are on screen, so both refetch, past the HTTP cache.
    expect(net.calls.slice(2)).toEqual([
      { url: "/api/items", cache: "reload" },
      { url: "/api/items?page=2", cache: "reload" },
    ]);
    await net.respond("/api/items", rows(1, 2));
    await net.respond("/api/items?page=2", rows(4, 5));
    expect(itemsText()).toBe("1,2,4,5");
  });

  test("a variant nobody renders is marked stale instead of refetched, and revalidates on its next read", async () => {
    const net = createNetwork();
    let mutate!: ReturnType<typeof useMutate>;
    function Mutator() {
      mutate = useMutate();
      return null;
    }
    function Switch() {
      const [query, setQuery] = useState<string | null>("old");
      return (
        <>
          <button onClick={() => setQuery(null)}>clear</button>
          <button onClick={() => setQuery("old")}>back</button>
          <Probe query={query} />
        </>
      );
    }
    function Probe(props: { query: string | null }) {
      const { data } = useQuery(
        "/items" as any,
        { search: { query: props.query } },
        { suspense: false, staleTime: Infinity, keepPreviousData: false },
      );
      return (
        <p data-testid="items">
          {(data as Row[] | undefined)?.map((r) => r.id).join(",")}
        </p>
      );
    }
    render(
      <Providers>
        <Switch />
        <Mutator />
      </Providers>,
    );
    await net.respond("/api/items?query=old", rows(1));
    fireEvent.click(screen.getByText("clear"));
    await net.respond("/api/items", rows(1, 2));

    act(() => {
      mutate({
        path: "/items" as any,
        search: (search) => search.get("query") === "old",
      });
    });
    // `query=old` is cached but not on screen: nothing goes on the wire.
    expect(net.urls()).toEqual(["/api/items?query=old", "/api/items"]);

    // Its next read revalidates it despite `staleTime: Infinity`.
    fireEvent.click(screen.getByText("back"));
    expect(itemsText()).toBe("1");
    expect(net.calls.at(-1)).toEqual({
      url: "/api/items?query=old",
      cache: "reload",
    });
    await net.respond("/api/items?query=old", rows(9));
    expect(itemsText()).toBe("9");
  });
});
