/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import type { PropsWithChildren } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { QueryManagerProvider } from "./QueryManagerContext";
import { RouteStateProvider, type PageData, type RouteState } from "./RouteStateContext";
import { useQuery as typedUseQuery } from "./useQuery";
import { useMutation, useUpload } from "./useMutation";
import { useInvalidate } from "./useInvalidate";
import { ServerQueryStore } from "../services/router/ServerQueryStore";
import { INVALIDATE_HEADER, encodeInvalidationKeys } from "../utils/invalidation";

/**
 * Declarative queries (#1329): a handler prefills a query under its key, the
 * client reads it with no request, and a mutation names the keys it changes
 * (itself, or the server in its answer) so the queries reading them refetch.
 */

// The routes are untyped here.
const useQuery = typedUseQuery as (
  path: string,
  options?: { params?: Record<string, any>; search?: Record<string, any> },
  config?: Record<string, any>,
) => { data: any; loading: boolean };

/**
 * GETs answer `<path+search>#<n>`, n counting the requests for that URL, so a
 * refetch shows on screen. Other methods answer `{}` with `mutationHeaders`.
 */
function stubNetwork(mutationHeaders: Record<string, string> = {}, mutationStatus = 200) {
  const gets: string[] = [];
  const fetchMock = vi.fn(async (input: string, init: { method?: string } = {}) => {
    if (init.method && init.method !== "GET") {
      return new Response("{}", { status: mutationStatus, headers: mutationHeaders });
    }
    const url = String(input).replace(/^\/api/, "");
    gets.push(url);
    const n = gets.filter((u) => u === url).length;
    return new Response(JSON.stringify(`${url}#${n}`), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { gets };
}

function Providers(props: PropsWithChildren<{ prefetchedData?: Record<string, unknown> }>) {
  return (
    <QueryManagerProvider>
      <RouteStateProvider
        state={{ prefetchedData: props.prefetchedData ?? {} } as RouteState & PageData}
      >
        {props.children}
      </RouteStateProvider>
    </QueryManagerProvider>
  );
}

function Reader(props: { id: string; path: string; search?: Record<string, any> }) {
  const { data } = useQuery(props.path, { search: props.search }, { suspense: false });
  return <p data-testid={props.id}>{data === undefined ? "…" : String(data)}</p>;
}

const text = (id: string) => screen.getByTestId(id).textContent;

let trigger: (input?: unknown) => Promise<unknown>;
function Mutation(props: { path: string; params?: Record<string, any>; invalidates?: string[] }) {
  const mutation = useMutation(
    "POST" as never,
    props.path as never,
    { params: props.params } as never,
    { invalidates: props.invalidates },
  );
  trigger = mutation.trigger as typeof trigger;
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a prefilled query", () => {
  test("hydrates into the client cache and is read with no request", async () => {
    // The server's half: a handler registers the data it resolved.
    const fetcher = vi.fn(async () => "from the route");
    const store = new ServerQueryStore(fetcher);
    store.prefill("/records/:collection", {
      params: { collection: "posts" },
      search: { sort: "title", limit: 10 },
    }, "prefilled");
    const prefetchedData = store.snapshotResolved();

    const net = stubNetwork();
    function View() {
      // Same key: the pattern with its params, search in any order.
      const { data, loading } = useQuery("/records/:collection", {
        params: { collection: "posts" },
        search: { limit: 10, sort: "title" },
      });
      return <p data-testid="posts">{`${data}:${loading}`}</p>;
    }
    render(
      <Providers prefetchedData={prefetchedData}>
        <View />
      </Providers>,
    );
    await act(async () => {});

    expect(text("posts")).toBe("prefilled:false");
    expect(net.gets).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("a mutation's `invalidates`", () => {
  function Screen(props: { invalidates?: string[]; params?: Record<string, any> }) {
    return (
      <Providers>
        <Reader id="posts" path="/records/posts" />
        <Reader id="drafts" path="/records/posts" search={{ status: "draft" }} />
        <Reader id="tags" path="/records/tags" />
        <Reader id="progress" path="/setup-progress" />
        <Mutation path="/records/:collection" params={props.params} invalidates={props.invalidates} />
      </Providers>
    );
  }
  const settled = () => waitFor(() => expect(text("progress")).toBe("/setup-progress#1"));

  test("a path refetches every mounted variant of it, and nothing else", async () => {
    const net = stubNetwork();
    render(<Screen invalidates={["/records/posts"]} params={{ collection: "posts" }} />);
    await settled();
    expect(net.gets).toHaveLength(4);

    await act(() => trigger({}));

    await waitFor(() => expect(text("posts")).toBe("/records/posts#2"));
    await waitFor(() => expect(text("drafts")).toBe("/records/posts?status=draft#2"));
    expect(text("tags")).toBe("/records/tags#1");
    expect(text("progress")).toBe("/setup-progress#1");
    expect(net.gets).toHaveLength(6);
  });

  test("`:param` segments are filled from the mutation's params", async () => {
    stubNetwork();
    render(<Screen invalidates={["/records/:collection"]} params={{ collection: "tags" }} />);
    await settled();

    await act(() => trigger({}));

    await waitFor(() => expect(text("tags")).toBe("/records/tags#2"));
    expect(text("posts")).toBe("/records/posts#1");
  });

  test("a `path?search` key refetches that variant alone", async () => {
    const net = stubNetwork();
    render(<Screen invalidates={["/records/posts?status=draft"]} params={{ collection: "posts" }} />);
    await settled();

    await act(() => trigger({}));

    await waitFor(() => expect(text("drafts")).toBe("/records/posts?status=draft#2"));
    expect(text("posts")).toBe("/records/posts#1");
    expect(net.gets).toHaveLength(5);
  });

  test("a prefix ending in `*` refetches every query under it", async () => {
    const net = stubNetwork();
    render(<Screen invalidates={["/records/*"]} params={{ collection: "posts" }} />);
    await settled();

    await act(() => trigger({}));

    await waitFor(() => expect(text("posts")).toBe("/records/posts#2"));
    await waitFor(() => expect(text("drafts")).toBe("/records/posts?status=draft#2"));
    await waitFor(() => expect(text("tags")).toBe("/records/tags#2"));
    expect(text("progress")).toBe("/setup-progress#1");
    expect(net.gets).toHaveLength(7);
  });

  test("a failed mutation invalidates nothing of its own", async () => {
    const net = stubNetwork({}, 422);
    render(<Screen invalidates={["/records/*"]} params={{ collection: "posts" }} />);
    await settled();

    await act(() => trigger({}));
    await act(async () => {});

    expect(net.gets).toHaveLength(4);
  });

  test("a query that is not on screen is marked stale and refetches when next read", async () => {
    const net = stubNetwork();
    function Toggle(props: { show: boolean }) {
      return (
        <Providers>
          {props.show ? <Reader id="posts" path="/records/posts" /> : null}
          <Reader id="progress" path="/setup-progress" />
          <Mutation path="/records/posts" invalidates={["/records/posts"]} />
        </Providers>
      );
    }
    const view = render(<Toggle show />);
    await waitFor(() => expect(text("posts")).toBe("/records/posts#1"));
    view.rerender(<Toggle show={false} />);

    await act(() => trigger({}));
    await act(async () => {});
    expect(net.gets.filter((url) => url === "/records/posts")).toHaveLength(1);

    view.rerender(<Toggle show />);
    await waitFor(() => expect(text("posts")).toBe("/records/posts#2"));
  });
});

describe("an invalidation the server declares", () => {
  test("the answer's header refetches the queries it names, with no `invalidates`", async () => {
    const net = stubNetwork({
      [INVALIDATE_HEADER]: encodeInvalidationKeys(["/setup-progress", "/records/*"]),
    });
    render(
      <Providers>
        <Reader id="posts" path="/records/posts" />
        <Reader id="progress" path="/setup-progress" />
        <Reader id="me" path="/me" />
        <Mutation path="/chat" />
      </Providers>,
    );
    await waitFor(() => expect(text("me")).toBe("/me#1"));

    await act(() => trigger({}));

    await waitFor(() => expect(text("progress")).toBe("/setup-progress#2"));
    await waitFor(() => expect(text("posts")).toBe("/records/posts#2"));
    expect(text("me")).toBe("/me#1");
    expect(net.gets).toHaveLength(5);
  });

  test("a key named by both the hook and the server refetches once", async () => {
    const net = stubNetwork({ [INVALIDATE_HEADER]: encodeInvalidationKeys(["/records/posts"]) });
    render(
      <Providers>
        <Reader id="posts" path="/records/posts" />
        <Mutation path="/records/posts" invalidates={["/records/posts", "/records/*"]} />
      </Providers>,
    );
    await waitFor(() => expect(text("posts")).toBe("/records/posts#1"));

    await act(() => trigger({}));

    await waitFor(() => expect(text("posts")).toBe("/records/posts#2"));
    await act(async () => {});
    expect(net.gets).toHaveLength(2);
  });

  test("it is honoured on a refusal too: the server knows what it wrote", async () => {
    stubNetwork({ [INVALIDATE_HEADER]: encodeInvalidationKeys(["/records/posts"]) }, 422);
    render(
      <Providers>
        <Reader id="posts" path="/records/posts" />
        <Mutation path="/records/posts" />
      </Providers>,
    );
    await waitFor(() => expect(text("posts")).toBe("/records/posts#1"));

    await act(() => trigger({}));

    await waitFor(() => expect(text("posts")).toBe("/records/posts#2"));
  });
});

describe("an upload", () => {
  test("honours its own `invalidates` and the server's header", async () => {
    stubNetwork();
    class FakeXHR extends EventTarget {
      static last: FakeXHR;
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
      getResponseHeader(name: string) {
        return name === INVALIDATE_HEADER ? encodeInvalidationKeys(["/setup-progress"]) : null;
      }
      respond() {
        this.status = 200;
        this.responseText = "{}";
        this.dispatchEvent(new ProgressEvent("load"));
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    let upload!: (file: File) => Promise<unknown>;
    function Uploader() {
      upload = useUpload("/files" as never, {} as never, { invalidates: ["/files"] } as never).trigger;
      return null;
    }
    render(
      <Providers>
        <Reader id="files" path="/files" />
        <Reader id="progress" path="/setup-progress" />
        <Reader id="me" path="/me" />
        <Uploader />
      </Providers>,
    );
    await waitFor(() => expect(text("me")).toBe("/me#1"));

    await act(async () => {
      const done = upload(new File(["hello"], "hello.txt"));
      FakeXHR.last.respond();
      await done;
    });

    await waitFor(() => expect(text("files")).toBe("/files#2"));
    await waitFor(() => expect(text("progress")).toBe("/setup-progress#2"));
    expect(text("me")).toBe("/me#1");
  });
});

describe("useInvalidate", () => {
  test("invalidates by key from outside a mutation", async () => {
    stubNetwork();
    let invalidate!: (...keys: string[]) => void;
    function Handle() {
      invalidate = useInvalidate();
      return null;
    }
    render(
      <Providers>
        <Reader id="posts" path="/records/posts" />
        <Reader id="progress" path="/setup-progress" />
        <Handle />
      </Providers>,
    );
    await waitFor(() => expect(text("progress")).toBe("/setup-progress#1"));

    act(() => invalidate("/setup-progress"));

    await waitFor(() => expect(text("progress")).toBe("/setup-progress#2"));
    expect(text("posts")).toBe("/records/posts#1");
  });
});

describe("a query whose inputs change", () => {
  test("runs again for the new inputs, and shares one entry per key", async () => {
    const net = stubNetwork();
    function View(props: { search: Record<string, any> }) {
      return (
        <Providers>
          <Reader id="list" path="/records/posts" search={props.search} />
        </Providers>
      );
    }
    const view = render(<View search={{ sort: "title", limit: 10 }} />);
    await waitFor(() => expect(text("list")).toBe("/records/posts?limit=10&sort=title#1"));

    // The same inputs as a new object, in another order: the same key.
    view.rerender(<View search={{ limit: 10, sort: "title" }} />);
    await act(async () => {});
    expect(net.gets).toHaveLength(1);

    view.rerender(<View search={{ limit: 20, sort: "title" }} />);
    await waitFor(() => expect(text("list")).toBe("/records/posts?limit=20&sort=title#1"));
    expect(net.gets).toHaveLength(2);

    // Back to the first inputs: its entry is still there.
    view.rerender(<View search={{ sort: "title", limit: 10 }} />);
    await waitFor(() => expect(text("list")).toBe("/records/posts?limit=10&sort=title#1"));
  });
});
