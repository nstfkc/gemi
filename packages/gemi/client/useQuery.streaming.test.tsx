/** @vitest-environment node */
import { afterEach, describe, expect, test, vi } from "vitest";
import { Suspense } from "react";
// @ts-ignore — same untyped entry the view router renders with.
import { renderToReadableStream } from "react-dom/server.browser";

import {
  ServerQueryStore,
  type ServerQueryFetcher,
} from "../services/router/ServerQueryStore";
import { injectQueryPayloads } from "../services/router/streamQueryInjection";
import { QueryManagerProvider } from "./QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "./RouteStateContext";
import { ServerQueryContext } from "./ServerQueryContext";
import { useQuery } from "./useQuery";

/**
 * The full streaming-SSR loop against the real pieces: a `useQuery` with no
 * data suspends the server render, React streams the shell with the fallback,
 * the store's settle queues the payload script ahead of React's reveal chunk,
 * and the settled document contains the rendered data.
 */

function createDeferredFetcher() {
  const calls: Array<{
    patternPath: string;
    resolve: (data: any) => void;
    reject: (error: any) => void;
  }> = [];
  const fetcher: ServerQueryFetcher = (patternPath) => {
    return new Promise((resolve, reject) => {
      calls.push({ patternPath, resolve, reject });
    });
  };
  return { fetcher, calls };
}

function App(props: {
  store: ServerQueryStore;
  state?: Partial<RouteState & PageData>;
  children: React.ReactNode;
}) {
  return (
    <ServerQueryContext.Provider value={props.store}>
      <QueryManagerProvider>
        <RouteStateProvider state={(props.state ?? {}) as RouteState & PageData}>
          {/* The host element matters: React does not stream a fallback for a
              boundary with no host content above it — it waits for the
              boundary instead. Real pages always have the root layout's
              html/body here. */}
          <main>
            <Suspense fallback={<div>skeleton</div>}>{props.children}</Suspense>
          </main>
        </RouteStateProvider>
      </QueryManagerProvider>
    </ServerQueryContext.Provider>
  );
}

async function streamedRender(store: ServerQueryStore, element: React.ReactNode) {
  store.markRenderStart();
  const stream: ReadableStream<Uint8Array> & { allReady: Promise<void> } =
    await renderToReadableStream(element, {
      onError: () => {},
    });
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = injectQueryPayloads(stream, store).getReader();
  const finished = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  })();
  // Let the shell flush before the caller settles anything.
  await new Promise((r) => setTimeout(r, 20));
  return { chunks, finished, html: () => chunks.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streaming SSR", () => {
  test("an undata'd query suspends the server render; the payload script precedes the revealed segment", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    function Metrics() {
      const { data } = useQuery("/metrics" as any);
      return <div>{`metric:${(data as any).signups}`}</div>;
    }

    const render = await streamedRender(
      store,
      <App store={store}>
        <Metrics />
      </App>,
    );

    // The shell went out immediately: fallback in place, no data, and the
    // fetch already on the wire (started at render discovery).
    await vi.waitFor(() => {
      expect(render.html()).toContain("skeleton");
    });
    const shell = render.html();
    expect(shell).not.toContain("metric:");
    expect(calls).toHaveLength(1);
    expect(calls[0].patternPath).toBe("/metrics");

    calls[0].resolve({ signups: 412 });
    await render.finished;

    const html = render.html();
    expect(html).toContain("metric:412");
    // Payload before reveal: hydration on the client can never observe the
    // revealed segment without its data in the cache.
    const scriptIndex = html.indexOf("__GEMI_STREAM__");
    expect(scriptIndex).toBeGreaterThan(-1);
    expect(html.slice(scriptIndex)).toContain('"/metrics"');
    expect(scriptIndex).toBeLessThan(html.indexOf("metric:412"));
  });

  test("a query resolved before the render ships in the document and never streams", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    const entry = store.ensure("/products", {}, "prefetch");
    calls[0].resolve({ names: ["Synapse"] });
    await entry.promise;
    const prefetchedData = store.snapshotResolved();

    function Products() {
      const { data } = useQuery("/products" as any);
      return <div>{`products:${(data as any).names.join(",")}`}</div>;
    }

    const render = await streamedRender(
      store,
      <App store={store} state={{ prefetchedData }}>
        <Products />
      </App>,
    );
    await render.finished;

    const html = render.html();
    expect(html).toContain("products:Synapse");
    expect(html).not.toContain("skeleton");
    expect(html).not.toContain("__GEMI_STREAM__");
  });

  test("a rejected query leaves the segment to the client and streams no payload", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    function Broken() {
      const { data } = useQuery("/broken" as any);
      return <div>{`broken:${JSON.stringify(data)}`}</div>;
    }

    const render = await streamedRender(
      store,
      <App store={store}>
        <Broken />
      </App>,
    );

    calls[0].reject(new Error("boom"));
    await render.finished;

    const html = render.html();
    // The client-render marker: fallback stays up, browser takes over, and
    // its own /api fetch surfaces the error into the boundary.
    expect(html).toContain("skeleton");
    expect(html).not.toContain("broken:");
    expect(html).not.toContain("__GEMI_STREAM__");
  });

  test("a query nested under a suspended parent is discovered late but still streams both segments", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    function Child() {
      const { data } = useQuery("/child" as any);
      return <div>{`child:${(data as any).value}`}</div>;
    }
    function Parent() {
      const { data } = useQuery("/parent" as any);
      return (
        <div>
          <div>{`parent:${(data as any).value}`}</div>
          <Suspense fallback={<div>child-skeleton</div>}>
            <Child />
          </Suspense>
        </div>
      );
    }

    const render = await streamedRender(
      store,
      <App store={store}>
        <Parent />
      </App>,
    );

    // Only the parent has been discovered — the child is gated behind it.
    expect(calls.map((c) => c.patternPath)).toEqual(["/parent"]);

    calls[0].resolve({ value: 1 });
    await vi.waitFor(() => {
      expect(calls.map((c) => c.patternPath)).toEqual(["/parent", "/child"]);
    });
    expect(store.read("/child", "")!.source).toBe("render");

    calls[1].resolve({ value: 2 });
    await render.finished;

    const html = render.html();
    expect(html).toContain("parent:1");
    expect(html).toContain("child:2");
    const childScript = html.indexOf('"/child"');
    expect(childScript).toBeLessThan(html.indexOf("child:2"));
  });
});
