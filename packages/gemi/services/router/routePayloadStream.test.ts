import { describe, expect, test } from "vitest";
import { ServerQueryStore, type ServerQueryFetcher } from "./ServerQueryStore";
import { createRoutePayloadStream } from "./routePayloadStream";

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

function collectLines(stream: ReadableStream<Uint8Array>) {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const finished = (async () => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
    }
  })();
  return { lines, finished };
}

describe("createRoutePayloadStream", () => {
  test("envelope is written immediately; query results stream behind it; closes when settled", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    // One resolved before the envelope (ships inside it), one still pending.
    const early = store.ensure("/early", {}, "prefetch");
    calls[0].resolve({ e: 1 });
    await early.promise;
    store.ensure("/late", { search: { page: 2 } }, "prefetch");

    const envelope = {
      data: { "/route": {} },
      prefetchedData: store.snapshotResolved(),
    };
    const { lines, finished } = collectLines(
      createRoutePayloadStream(envelope, store),
    );

    // The envelope must not wait for the pending query.
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toHaveLength(1);
    const parsedEnvelope = JSON.parse(lines[0]);
    expect(parsedEnvelope.prefetchedData).toEqual({ "/early": { "": { e: 1 } } });

    calls[1].resolve({ rows: [1, 2] });
    await finished;

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toEqual(["/late", "page=2", { rows: [1, 2] }]);
  });

  test("snapshot-shipped entries are not sent twice; rejected entries are not sent at all", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);

    const shipped = store.ensure("/shipped", {}, "prefetch");
    calls[0].resolve({ s: 1 });
    await shipped.promise;
    store.ensure("/broken", {}, "prefetch");

    const envelope = { prefetchedData: store.snapshotResolved() };
    const { lines, finished } = collectLines(
      createRoutePayloadStream(envelope, store),
    );

    calls[1].reject(new Error("boom"));
    await finished;

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).prefetchedData["/shipped"]).toEqual({
      "": { s: 1 },
    });
  });

  test("the deadline closes the stream with a hung query still pending", async () => {
    const { fetcher } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    store.ensure("/hung", {}, "prefetch");

    const { lines, finished } = collectLines(
      createRoutePayloadStream({ ok: true }, store, 20),
    );

    await finished;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ ok: true });
  });

  test("a query settling after the deadline does not throw against the closed stream", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    const slow = store.ensure("/slow", {}, "prefetch");

    const { finished } = collectLines(createRoutePayloadStream({}, store, 10));
    await finished;

    calls[0].resolve({ too: "late" });
    await slow.promise;
    expect(slow.status).toBe("resolved");
  });

  test("onClose fires once when the last query has streamed; the summary has shellAt === settledAt", async () => {
    const { fetcher, calls } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    store.ensure("/pending", {}, "prefetch");

    const closes: Array<{ aborted: boolean }> = [];
    const { lines, finished } = collectLines(
      createRoutePayloadStream({ ok: true }, store, undefined, (info) => {
        closes.push(info);
      }),
    );

    // The envelope alone does not complete the stream.
    await new Promise((r) => setTimeout(r, 10));
    expect(closes).toHaveLength(0);

    calls[0].resolve({ p: 1 });
    await finished;

    expect(lines).toHaveLength(2);
    expect(closes).toEqual([{ aborted: false }]);
    // The NDJSON body is one payload, never a shell followed by streamed
    // content — no shell mark, so the summary collapses the two times.
    const summary = store.summarize(closes[0].aborted);
    expect(summary.shellAt).toBe(summary.settledAt);
    expect(summary.aborted).toBe(false);
  });

  test("onClose reports aborted when the deadline cut a hung query loose", async () => {
    const { fetcher } = createDeferredFetcher();
    const store = new ServerQueryStore(fetcher);
    store.ensure("/hung", {}, "prefetch");

    const closes: Array<{ aborted: boolean }> = [];
    const { finished } = collectLines(
      createRoutePayloadStream({ ok: true }, store, 20, (info) => {
        closes.push(info);
      }),
    );

    await finished;
    expect(closes).toEqual([{ aborted: true }]);

    const summary = store.summarize(true);
    expect(summary.aborted).toBe(true);
    expect(summary.queries).toEqual([
      {
        path: "/hung",
        variantKey: "",
        startedAt: expect.any(Number),
        settledAt: undefined,
        status: "pending",
        source: "prefetch",
      },
    ]);
  });
});
