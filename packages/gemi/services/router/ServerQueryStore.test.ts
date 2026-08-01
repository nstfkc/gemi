import { afterEach, describe, expect, test, vi } from "vitest";
import { ServerQueryStore, type ServerQueryFetcher } from "./ServerQueryStore";
import {
  htmlSafeJson,
  injectQueryPayloads,
  isBotUserAgent,
  queryPayloadScript,
} from "./streamQueryInjection";

/** A hand-cranked source standing in for React's SSR stream. */
function createSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    write: (html: string) => controller.enqueue(encoder.encode(html)),
    close: () => controller.close(),
  };
}

function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const finished = (async () => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  })();
  return { chunks, finished };
}

function createDeferredFetcher() {
  const calls: Array<{
    patternPath: string;
    params: Record<string, any>;
    searchParams: URLSearchParams;
    resolve: (data: any) => void;
    reject: (error: any) => void;
  }> = [];
  const fetcher: ServerQueryFetcher = (patternPath, params, searchParams) => {
    return new Promise((resolve, reject) => {
      calls.push({ patternPath, params, searchParams, resolve, reject });
    });
  };
  return { fetcher, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ServerQueryStore", () => {
  test("ensure dedupes by path and variant across repeated calls", () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    const first = store.ensure("/products", { search: { page: 1 } });
    for (let i = 0; i < 9; i++) {
      expect(store.ensure("/products", { search: { page: 1 } })).toBe(first);
    }
    expect(calls).toHaveLength(1);

    store.ensure("/products", { search: { page: 2 } });
    expect(calls).toHaveLength(2);
  });

  test("keys apply params, sort search, drop nullish values and `json`", () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    const entry = store.ensure("/posts/:id", {
      params: { id: "42" },
      search: { b: "2", a: "1", skip: null, json: "true" },
    });

    expect(entry.path).toBe("/posts/42");
    expect(entry.variantKey).toBe("a=1&b=2");
    expect(calls[0].patternPath).toBe("/posts/:id");
    expect(calls[0].searchParams.toString()).toBe("a=1&b=2");
  });

  test("promise settles only after data is recorded and the settle listener ran", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    const order: string[] = [];

    store.onSettle((entry) => {
      order.push(`listener:${entry.status}:${JSON.stringify(entry.data)}`);
    });

    const entry = store.ensure("/products");
    const woken = entry.promise.then(() => {
      order.push(`woken:${entry.status}`);
    });

    calls[0].resolve({ value: 1 });
    await woken;

    expect(order).toEqual(['listener:resolved:{"value":1}', "woken:resolved"]);
  });

  test("a rejected fetch records the error and resolves the promise anyway", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    const entry = store.ensure("/broken");
    calls[0].reject(new Error("boom"));

    await expect(entry.promise).resolves.toBeUndefined();
    expect(entry.status).toBe("rejected");
    expect(entry.error.message).toBe("boom");
  });

  test("allSettled waits for entries added while waiting", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    store.ensure("/first");
    const all = store.allSettled();
    let done = false;
    all.then(() => {
      done = true;
    });

    // Settling the first entry spawns a second — the loop must pick it up.
    calls[0].resolve({ n: 1 });
    await store.read("/first", "")!.promise;
    store.ensure("/second");
    await Promise.resolve();
    expect(done).toBe(false);

    calls[1].resolve({ n: 2 });
    await all;
    expect(store.read("/second", "")!.status).toBe("resolved");
  });

  test("snapshotResolved groups variants per path and excludes pending/rejected", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    const a1 = store.ensure("/products", { search: { page: 1 } });
    const a2 = store.ensure("/products", { search: { page: 2 } });
    store.ensure("/pending");
    const broken = store.ensure("/broken");

    calls[0].resolve({ page: 1 });
    calls[1].resolve({ page: 2 });
    calls[3].reject(new Error("nope"));
    await Promise.all([a1.promise, a2.promise, broken.promise]);

    expect(store.snapshotResolved()).toEqual({
      "/products": { "page=1": { page: 1 }, "page=2": { page: 2 } },
    });
  });

  test("onSettle replays the backlog but skips snapshotted entries", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    const shipped = store.ensure("/shipped");
    const backlogged = store.ensure("/backlogged");
    calls[0].resolve({ s: 1 });
    calls[1].resolve({ b: 1 });
    await Promise.all([shipped.promise, backlogged.promise]);

    // `/shipped` goes out with the document payload; `/backlogged` didn't
    // make the snapshot (simulated by snapshotting selectively is not
    // possible — both resolved — so snapshot first, then add a new entry).
    store.snapshotResolved();

    const late = store.ensure("/late");
    calls[2].resolve({ l: 1 });
    await late.promise;

    const seen: string[] = [];
    store.onSettle((entry) => seen.push(entry.path));
    expect(seen).toEqual(["/late"]);
  });

  test("late render discovery hints at settle with the resolved size; prefetch and first-pass stay silent", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    const beforeRender = store.ensure("/before-render", {}, "prefetch");
    store.markRenderStart();
    const firstPass = store.ensure("/first-pass", {}, "render");

    clock = 640;
    const late = store.ensure("/late-one", { search: { locale: "en-US" } }, "render");
    const latePrefetch = store.ensure("/late-prefetch", {}, "prefetch");

    // Nothing is logged at discovery — the hint waits for the payload.
    expect(warn).not.toHaveBeenCalled();

    calls[0].resolve({ a: 1 });
    calls[1].resolve({ b: 2 });
    calls[2].resolve({ rows: "x".repeat(2048) });
    calls[3].resolve({ c: 3 });
    await Promise.all([
      beforeRender.promise,
      firstPass.promise,
      late.promise,
      latePrefetch.promise,
    ]);

    // Only the late render-discovered entry hints, with size and both remedies.
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0];
    expect(message).toContain('useQuery("/late-one") was discovered 640ms');
    expect(message).toContain("resolved 2.0 kB");
    expect(message).toContain(
      'Query.prefetch("/late-one", { search: {"locale":"en-US"} })',
    );
    expect(message).toContain("every client-side navigation payload");
    expect(message).toContain("lazy: true");
    expect(message).toContain("Query.noPrefetch()");
  });

  test("a rejected late discovery logs no hint, and muteDiscoveryHints silences resolved ones", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    store.markRenderStart();
    clock = 500;

    const failing = store.ensure("/late-broken", {}, "render");
    calls[0].reject(new Error("boom"));
    await failing.promise;
    expect(warn).not.toHaveBeenCalled();

    store.muteDiscoveryHints();
    const muted = store.ensure("/late-muted", {}, "render");
    calls[1].resolve({ big: "payload" });
    await muted.promise;
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("stream injection", () => {
  test("htmlSafeJson cannot break out of a script element", () => {
    const json = htmlSafeJson({ evil: "</script><script>alert(1)</script>" });
    expect(json).not.toContain("</script>");
    expect(JSON.parse(json)).toEqual({
      evil: "</script><script>alert(1)</script>",
    });
  });

  test("payload scripts self-shim the buffer", () => {
    const script = queryPayloadScript({
      path: "/products",
      patternPath: "/products",
      variantKey: "page=1",
      status: "resolved",
      data: { ok: true },
      promise: Promise.resolve(),
      source: "prefetch",
      startedAt: 0,
    });
    expect(script).toContain("self.__GEMI_STREAM__=self.__GEMI_STREAM__||[]");
    expect(script).toContain('.push(["/products","page=1",{"ok":true}])');
  });

  test("a payload settled mid-stream lands after the current chunk and before the reveal chunk", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    const source = createSource();
    const { chunks, finished } = collect(injectQueryPayloads(source.stream, store));

    const entry = store.ensure("/metrics");
    source.write("<!doctype html><div>shell</div>");
    calls[0].resolve({ signups: 412 });
    await entry.promise;
    source.write("<div hidden>revealed segment</div>");
    source.close();
    await finished;

    expect(chunks).toEqual([
      "<!doctype html><div>shell</div>",
      `<script>(self.__GEMI_STREAM__=self.__GEMI_STREAM__||[]).push(["/metrics","",${JSON.stringify(
        { signups: 412 },
      )}])</script>`,
      "<div hidden>revealed segment</div>",
    ]);
  });

  test("nothing is injected ahead of the first chunk; leftovers flush at close", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    const source = createSource();
    const { chunks, finished } = collect(injectQueryPayloads(source.stream, store));

    // Settles before any HTML exists — must not precede the doctype.
    const early = store.ensure("/early");
    calls[0].resolve({ e: 1 });
    await early.promise;

    source.write("<!doctype html>");

    // Settles after React's last chunk — an unused prefetch — must still ship.
    const unused = store.ensure("/unused");
    calls[1].resolve({ u: 1 });
    await unused.promise;

    source.close();
    await finished;

    expect(chunks[0]).toBe("<!doctype html>");
    expect(chunks.join("")).toContain('"/early"');
    expect(chunks.join("")).toContain('"/unused"');
    expect(chunks.join("").indexOf("<!doctype html>")).toBe(0);
  });

  test("rejected entries stream nothing", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    const source = createSource();
    const { chunks, finished } = collect(injectQueryPayloads(source.stream, store));

    source.write("<!doctype html>");

    const entry = store.ensure("/broken");
    calls[0].reject(new Error("boom"));
    await entry.promise;

    source.close();
    await finished;

    expect(chunks.join("")).toBe("<!doctype html>");
  });
});

describe("isBotUserAgent", () => {
  test("classifies common crawlers and spares browsers", () => {
    expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(isBotUserAgent("Chrome-Lighthouse")).toBe(true);
    expect(isBotUserAgent(null)).toBe(false);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      ),
    ).toBe(false);
  });
});
