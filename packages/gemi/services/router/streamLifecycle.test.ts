import { beforeEach, describe, expect, test, vi } from "vitest";
import { createElement, Suspense } from "react";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { kernelContext } from "../../kernel/context";
import { RequestContext } from "../../http/requestContext";
import { Query } from "../../facades/Prefetch";
import { QueryError } from "../../client/QueryError";
import { ApiRouterServiceProvider } from "./ApiRouterServiceProvider";
import { ViewRouterServiceProvider } from "./ViewRouterServiceProvider";
import type { ServerQueryStore, StreamSummary } from "./ServerQueryStore";

/**
 * Container-level coverage for the stream lifecycle hooks (#293): full
 * requests through `app.fetch`, with the response body consumed *after*
 * `app.fetch` resolved — outside `kernel.run`, exactly the shape the HTTP
 * server produces in production. The unit tests cover the store and stream
 * primitives; these cover the provider wiring the acceptance criteria name.
 */

process.env.SECRET ??= "stream-lifecycle-test-secret";

const SLOW_QUERY_MS = 60;

/** What the provider hooks observed, including whether the scopes were live. */
const streamCompletions: Array<{
  summary: StreamSummary;
  hasKernelScope: boolean;
  hasRequestCtx: boolean;
}> = [];
const requestFailures: Array<{
  error: any;
  hasKernelScope: boolean;
  hasRequestCtx: boolean;
}> = [];

class TestApiRouter extends ApiRouter {
  routes = {
    "/slow": this.get(async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_QUERY_MS));
      return { rows: [1, 2, 3] };
    }),
    "/broken": this.get(() => {
      throw new Error("boom");
    }),
  };
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => {
      (Query as any).prefetch("/slow");
      return { Home: { title: "home" } };
    }),
    "/fails": this.view("Fails", () => {
      (Query as any).prefetch("/broken");
      return { Fails: {} };
    }),
    "/instant": this.view("Instant", async () => {
      return { Instant: { data: await (Query as any).instant("/broken") } };
    }),
    "/crash": this.view("Crash", () => {
      return { Crash: {} };
    }),
  };
}

/** Suspends on the slow query the way a server-rendered `useQuery` does. */
function SlowSegment({ entry }: any) {
  if (entry.status === "pending") throw entry.promise;
  return createElement("div", null, JSON.stringify(entry.data));
}

function TestRoot(props: any) {
  if (props.data?.router?.pathname === "/crash") {
    throw new Error("shell crashed");
  }
  const store: ServerQueryStore | undefined = props.serverQueries;
  const entry = store?.read("/slow", "");
  if (!entry) return createElement("div", null, "static");
  // The Suspense boundary sits under a host element, like any real root
  // layout — a boundary at the very root makes React defer the shell flush
  // until the boundary settles, which would hide the shell/stream split this
  // suite exists to observe.
  return createElement(
    "div",
    null,
    createElement(
      Suspense,
      { fallback: createElement("div", null, "loading") },
      createElement(SlowSegment, { entry }),
    ),
  );
}

class TestApiProvider extends ApiRouterServiceProvider {
  rootRouter = TestApiRouter;
}

class TestViewProvider extends ViewRouterServiceProvider {
  root = TestRoot;
  rootRouter = TestViewRouter;

  onStreamComplete(_req: any, summary: StreamSummary) {
    streamCompletions.push({
      summary,
      hasKernelScope: Boolean(kernelContext.getStore()),
      hasRequestCtx: Boolean(RequestContext.getStore()?.req),
    });
  }

  onRequestFail(_req: any, error: any) {
    requestFailures.push({
      error,
      hasKernelScope: Boolean(kernelContext.getStore()),
      hasRequestCtx: Boolean(RequestContext.getStore()?.req),
    });
  }
}

class TestKernel extends Kernel {
  protected apiRouterServiceProvider = TestApiProvider;
  protected viewRouterServiceProvider = TestViewProvider;
}

const app = new App({ kernel: TestKernel });

/** The build-artifact params the dev/prod servers pass to the render fn. */
const renderParams = {
  getStyles: async () => [],
  viewImportMap: {},
  viewModules: {},
  bootstrapModules: [],
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
};

/**
 * Fetches a document route and consumes its body the way the HTTP server
 * does: the render fn is invoked, and the body read, only after `app.fetch`
 * resolved — outside the kernel scope.
 */
async function fetchDocument(path: string) {
  const result = await app.fetch(
    new Request(`http://gemi.dev${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) TestBrowser/1.0" },
    }),
  );
  expect(typeof result).toBe("function");
  const res: Response = await (result as any)(renderParams);
  return res;
}

async function readAll(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

beforeEach(() => {
  streamCompletions.length = 0;
  requestFailures.length = 0;
});

describe("stream lifecycle hooks through app.fetch", () => {
  test("onStreamComplete fires once after the streamed document body closes, inside the request scopes", async () => {
    const res = await fetchDocument("/");

    // The handler has returned, but the body hasn't been consumed — the
    // hook is pinned to the body closing, so it must not have fired yet.
    expect(streamCompletions).toHaveLength(0);

    const html = await readAll(res.body!);

    expect(streamCompletions).toHaveLength(1);
    const { summary, hasKernelScope, hasRequestCtx } = streamCompletions[0];

    // The body is driven outside `kernel.run`; the router must have
    // re-entered the scopes so facades and `req.ctx()` work in the hook.
    expect(hasKernelScope).toBe(true);
    expect(hasRequestCtx).toBe(true);

    // Suspending page: first byte at time-to-shell, body open until the
    // slowest query streamed.
    expect(summary.aborted).toBe(false);
    expect(summary.shellAt).toBeLessThan(summary.settledAt);
    expect(summary.settledAt).toBeGreaterThanOrEqual(SLOW_QUERY_MS - 10);
    expect(summary.queries).toEqual([
      expect.objectContaining({
        path: "/slow",
        status: "resolved",
        source: "prefetch",
      }),
    ]);

    // The query payload streamed into the body before it closed.
    expect(html).toContain("__GEMI_STREAM__");
    expect(html).toContain('"/slow"');
  });

  test(".json navigation payloads report shellAt === settledAt", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/.json"));
    expect(res).toBeInstanceOf(Response);

    const body = await readAll((res as Response).body!);

    expect(streamCompletions).toHaveLength(1);
    const { summary, hasKernelScope, hasRequestCtx } = streamCompletions[0];
    expect(hasKernelScope).toBe(true);
    expect(hasRequestCtx).toBe(true);
    expect(summary.shellAt).toBe(summary.settledAt);
    expect(summary.aborted).toBe(false);
    expect(summary.queries).toEqual([
      expect.objectContaining({ path: "/slow", status: "resolved" }),
    ]);
    // Envelope line plus one streamed payload line.
    expect(body.trimEnd().split("\n")).toHaveLength(2);
  });

  test("a rejected streamed prefetch invokes onRequestFail exactly once, with a QueryError, in scope", async () => {
    const res = await fetchDocument("/fails");
    await readAll(res.body!);

    // The rejection settles independently of the body; wait for the report.
    await vi.waitFor(() => expect(requestFailures).toHaveLength(1));
    // Give a hypothetical duplicate report a chance to land before asserting
    // exactly-once.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requestFailures).toHaveLength(1);
    const { error, hasKernelScope, hasRequestCtx } = requestFailures[0];
    expect(hasKernelScope).toBe(true);
    expect(hasRequestCtx).toBe(true);

    // Raw api-handler throws arrive wrapped: path/variant/status attached,
    // original error on `cause`.
    expect(error).toBeInstanceOf(QueryError);
    expect(error.path).toBe("/broken");
    expect(error.status).toBe(500);
    expect((error.cause as Error).message).toBe("boom");

    // The body still closed and reported the rejected query.
    expect(streamCompletions).toHaveLength(1);
    expect(streamCompletions[0].summary.queries).toEqual([
      expect.objectContaining({ path: "/broken", status: "rejected" }),
    ]);
  });

  test("a Query.instant rethrow into the handler is reported exactly once", async () => {
    await expect(
      app.fetch(new Request("http://gemi.dev/instant.json")),
    ).rejects.toThrow("boom");

    await vi.waitFor(() => expect(requestFailures.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The settle-time report and the handler rethrow are the same error
    // object; the identity dedupe must collapse them to one report.
    expect(requestFailures).toHaveLength(1);
    expect(requestFailures[0].error).toBeInstanceOf(QueryError);
  });

  test("onStreamComplete still fires when the shell render crashes", async () => {
    const res = await fetchDocument("/crash");
    const html = await readAll(res.body!);

    expect(streamCompletions).toHaveLength(1);
    const { summary, hasKernelScope } = streamCompletions[0];
    expect(hasKernelScope).toBe(true);
    expect(summary.aborted).toBe(false);
    // The fallback error document carries the crash for the client runtime.
    expect(html).toContain("shell crashed");
  });
});
