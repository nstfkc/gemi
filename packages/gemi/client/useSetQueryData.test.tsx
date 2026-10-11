/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render, screen } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useQuery } from "./useQuery";
import { useMutation, useUpload } from "./useMutation";
import { useSetQueryData } from "./useSetQueryData";

/**
 * Issue #897: a mutation's answer written into another query's cache with no
 * refetch, through `updates` on the mutation hooks or `useSetQueryData()`.
 */

type Pending = { url: string; resolve: (body: unknown, status?: number) => void };

/** GETs wait for the test to answer them; mutations answer from `answers`. */
function createFetch(answers: Record<string, { status?: number; body: unknown }> = {}) {
  const pending: Pending[] = [];
  const calls: Array<{ method: string; url: string }> = [];
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url });
    if (method !== "GET") {
      const answer = answers[`${method} ${url}`] ?? { body: {} };
      const status = answer.status ?? 200;
      return Promise.resolve({
        ok: status < 300,
        status,
        json: async () => answer.body,
      } as Response);
    }
    return new Promise<Response>((resolve) => {
      pending.push({
        url,
        resolve: (body, status = 200) =>
          resolve({
            ok: status < 300,
            status,
            headers: new Headers(),
            json: async () => body,
          } as unknown as Response),
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    gets: () => calls.filter((call) => call.method === "GET").map((call) => call.url),
    async resolve(url: string, body: unknown) {
      const index = pending.findIndex((p) => p.url === url);
      if (index < 0) throw new Error(`No pending fetch for ${url}`);
      const [p] = pending.splice(index, 1);
      await act(async () => p.resolve(body));
    },
  };
}

function providers(params: Record<string, string> = {}) {
  return function Providers(props: PropsWithChildren) {
    return (
      <QueryManagerProvider>
        <RouteStateProvider state={{ params } as unknown as RouteState & PageData}>
          {props.children}
        </RouteStateProvider>
      </QueryManagerProvider>
    );
  };
}

function Reader(props: { path: string; search?: Record<string, string>; id: string }) {
  const { data } = useQuery(props.path as any, { search: props.search ?? {} } as any, {
    suspense: false,
  });
  return <p data-testid={props.id}>{data === undefined ? "loading" : JSON.stringify(data)}</p>;
}

let latest: Record<string, any> = {};
function Mutation(props: { url: string; config: Record<string, any>; id?: string }) {
  latest[props.id ?? "m"] = useMutation("POST" as any, props.url as any, {}, props.config as any);
  return null;
}

function text(id: string) {
  return screen.getByTestId(id).textContent;
}

async function trigger(id = "m", input: unknown = {}) {
  await act(async () => {
    await latest[id].trigger(input);
  });
}

afterEach(() => {
  cleanup();
  latest = {};
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useMutation updates", () => {
  test("writes the answer into the query, with no refetch", async () => {
    const net = createFetch({ "POST /api/assets/move": { body: { files: ["b"] } } });
    render(
      <>
        <Reader path="/assets" id="assets" />
        <Mutation url="/assets/move" config={{ updates: [{ path: "/assets" }] }} />
      </>,
      { wrapper: providers() },
    );
    await net.resolve("/api/assets", { files: ["a"] });
    expect(text("assets")).toBe(JSON.stringify({ files: ["a"] }));

    await trigger();

    expect(text("assets")).toBe(JSON.stringify({ files: ["b"] }));
    expect(net.gets()).toEqual(["/api/assets"]);
  });

  test("`data` builds the next value from the answer and the cache, on every variant a predicate accepts", async () => {
    const net = createFetch({ "POST /api/todos": { body: { id: 3 } } });
    render(
      <>
        <Reader path="/todos" id="all" />
        <Reader path="/todos" search={{ done: "1" }} id="done" />
        <Mutation
          url="/todos"
          config={{
            updates: [
              {
                path: "/todos",
                search: (search: URLSearchParams) => !search.has("done"),
                data: (created: any, todos: any[]) => [...todos, created],
              },
            ],
          }}
        />
      </>,
      { wrapper: providers() },
    );
    await net.resolve("/api/todos", [{ id: 1 }]);
    await net.resolve("/api/todos?done=1", [{ id: 2 }]);

    await trigger();

    expect(text("all")).toBe(JSON.stringify([{ id: 1 }, { id: 3 }]));
    expect(text("done")).toBe(JSON.stringify([{ id: 2 }]));
    expect(net.gets()).toHaveLength(2);
  });

  test("runs before onSuccess, and a failed request writes nothing", async () => {
    const net = createFetch({
      "POST /api/assets/move": { body: { files: ["b"] } },
      "POST /api/assets/fail": {
        status: 422,
        body: { error: { kind: "validation_error", messages: {} } },
      },
    });
    const seen: Array<string | null> = [];
    render(
      <>
        <Reader path="/assets" id="assets" />
        <Mutation
          url="/assets/move"
          config={{
            updates: [{ path: "/assets" }],
            onSuccess: () => seen.push(screen.getByTestId("assets").textContent),
          }}
        />
        <Mutation url="/assets/fail" id="fail" config={{ updates: [{ path: "/assets" }] }} />
      </>,
      { wrapper: providers() },
    );
    await net.resolve("/api/assets", { files: ["a"] });

    await trigger("fail");
    expect(text("assets")).toBe(JSON.stringify({ files: ["a"] }));

    await trigger();
    // The store write lands before onSuccess; the reader re-renders with it.
    expect(text("assets")).toBe(JSON.stringify({ files: ["b"] }));
    expect(seen).toHaveLength(1);
  });

  test("params are merged over the route's", async () => {
    const net = createFetch({ "POST /api/pages/p1/rename": { body: { name: "new" } } });
    render(
      <>
        <Reader path="/pages/p1" id="page" />
        <Mutation url="/pages/:pageId/rename" config={{ updates: [{ path: "/pages/:pageId" }] }} />
      </>,
      { wrapper: providers({ pageId: "p1" }) },
    );
    await net.resolve("/api/pages/p1", { name: "old" });

    await trigger();

    expect(text("page")).toBe(JSON.stringify({ name: "new" }));
  });

  test("a GET already on the wire cannot put the older data back", async () => {
    const net = createFetch({ "POST /api/assets/move": { body: { files: ["b"] } } });
    render(
      <>
        <Reader path="/assets" id="assets" />
        <Mutation url="/assets/move" config={{ updates: [{ path: "/assets" }] }} />
      </>,
      { wrapper: providers() },
    );

    await trigger();
    expect(text("assets")).toBe(JSON.stringify({ files: ["b"] }));

    await net.resolve("/api/assets", { files: ["a"] });
    expect(text("assets")).toBe(JSON.stringify({ files: ["b"] }));
  });

  test("a value seeds an uncached variant; `data` skips one", async () => {
    const net = createFetch({ "POST /api/things": { body: { id: 1 } } });
    function Later(props: { show: boolean }) {
      return props.show ? (
        <>
          <Reader path="/things/seeded" id="seeded" />
          <Reader path="/things/skipped" id="skipped" />
        </>
      ) : null;
    }
    const { rerender } = render(
      <>
        <Later show={false} />
        <Mutation
          url="/things"
          config={{
            updates: [
              { path: "/things/seeded" },
              { path: "/things/skipped", data: () => ({ id: 99 }) },
            ],
          }}
        />
      </>,
      { wrapper: providers() },
    );

    await trigger();
    rerender(
      <>
        <Later show />
        <Mutation url="/things" config={{}} />
      </>,
    );

    expect(text("seeded")).toBe(JSON.stringify({ id: 1 }));
    expect(text("skipped")).toBe("loading");
    expect(net.gets()).toEqual(["/api/things/skipped"]);
  });
});

describe("useUpload updates", () => {
  test("writes the upload's answer into the query", async () => {
    const net = createFetch();
    class FakeXHR extends EventTarget {
      static last: FakeXHR | null = null;
      upload = new EventTarget();
      status = 0;
      statusText = "";
      responseText = "";
      constructor() {
        super();
        FakeXHR.last = this;
      }
      open() {}
      send() {}
      respond(status: number, body: string) {
        this.status = status;
        this.responseText = body;
        this.dispatchEvent(new ProgressEvent("load"));
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    let upload: any;
    function Uploader() {
      upload = useUpload("/files" as any, {}, { updates: [{ path: "/files" }] } as any);
      return null;
    }
    render(
      <>
        <Reader path="/files" id="files" />
        <Uploader />
      </>,
      { wrapper: providers() },
    );
    await net.resolve("/api/files", ["a"]);

    let done!: Promise<unknown>;
    act(() => {
      done = upload.trigger(new File(["x"], "b.txt"));
    });
    await act(async () => {
      FakeXHR.last!.respond(200, JSON.stringify(["a", "b"]));
      await done;
    });

    expect(text("files")).toBe(JSON.stringify(["a", "b"]));
    expect(net.gets()).toEqual(["/api/files"]);
  });
});

describe("useSetQueryData", () => {
  test("a value replaces and a function updates, with no refetch", async () => {
    const net = createFetch();
    let setQueryData!: ReturnType<typeof useSetQueryData>;
    function Writer() {
      setQueryData = useSetQueryData();
      return null;
    }
    render(
      <>
        <Reader path="/todos" id="todos" />
        <Writer />
      </>,
      { wrapper: providers() },
    );
    await net.resolve("/api/todos", [1]);

    act(() => setQueryData({ path: "/todos" as never }, [1, 2] as never));
    expect(text("todos")).toBe("[1,2]");

    act(() =>
      setQueryData({ path: "/todos" as never }, ((todos: number[]) => [...todos, 3]) as never),
    );
    expect(text("todos")).toBe("[1,2,3]");
    expect(net.gets()).toEqual(["/api/todos"]);
  });
});
