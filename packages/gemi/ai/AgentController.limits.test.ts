process.env.SECRET ??= "agent-controller-limits-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import type { AgentStreamParams } from "./Agent";
import {
  AgentController,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_HISTORY_MESSAGES,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import { StubAgentRun } from "./store/stubAgentRun";
import type { AgentMessage } from "./types";

/**
 * #444: the caps on what one caller can make the agent route spend — the body
 * it reads, the history a stateless turn sends the model, and how many runs it
 * holds at once.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An agent whose every turn is a fresh hand-driven run, kept for the test. */
function stubAgent() {
  const runs: StubAgentRun[] = [];
  const calls: AgentStreamParams[] = [];
  return {
    runs,
    calls,
    agent: {
      name: "stub",
      tools: [] as const,
      skills: [] as const,
      output: undefined,
      stream: (params: AgentStreamParams) => {
        calls.push(params);
        const run = new StubAgentRun(params.runId ?? `run_${runs.length}`);
        runs.push(run);
        return run;
      },
    } as any,
  };
}

function limited(
  overrides: {
    maxBodyBytes?: number;
    maxHistoryMessages?: number;
    maxConcurrentRuns?: number;
    runLimitKey?: (owner: string | null) => string | null;
  } = {},
) {
  const stub = stubAgent();
  class Chat extends AgentController {
    agent = stub.agent;
    liveRuns = new MemoryLiveRuns();
    store = new MemoryAgentStore({ clientOwnedIds: true });
    constructor() {
      super();
      if (overrides.maxBodyBytes !== undefined)
        this.maxBodyBytes = overrides.maxBodyBytes;
      if (overrides.maxHistoryMessages !== undefined) {
        this.maxHistoryMessages = overrides.maxHistoryMessages;
      }
      if (overrides.maxConcurrentRuns !== undefined) {
        this.maxConcurrentRuns = overrides.maxConcurrentRuns;
      }
    }
    protected runLimitKey(
      req: HttpRequest<any, any>,
      params: { owner: string | null },
    ) {
      return overrides.runLimitKey
        ? overrides.runLimitKey(params.owner)
        : super.runLimitKey(req, params);
    }
  }
  // One registry for every request of the test, as a real app has: the
  // controller is constructed per request.
  const liveRuns = new MemoryLiveRuns();
  const controller = () => {
    const c = new Chat();
    c.liveRuns = liveRuns;
    return c;
  };
  return { ...stub, controller };
}

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

/** A body with no `Content-Length`, as a chunked upload arrives. */
function chunkedRequest(text: string) {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1024)
        controller.enqueue(bytes.slice(i, i + 1024));
      controller.close();
    },
  });
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    // @ts-expect-error -- required by the fetch spec for a stream body, not in the DOM types
    duplex: "half",
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

function as<T>(
  id: number | null,
  req: HttpRequest<any, any>,
  fn: () => Promise<T>,
): Promise<T> {
  return RequestContext.run(req as any, async () => {
    if (id !== null) RequestContext.getStore().setUser({ id });
    return await fn();
  });
}

async function send(
  make: () => AgentController,
  id: number | null,
  body: Record<string, unknown>,
): Promise<Response> {
  const req = jsonRequest({ text: "hi", ...body });
  return await as(id, req, () => make().stream(req));
}

const message = (i: number): AgentMessage => ({
  id: `m${i}`,
  role: i % 2 ? "assistant" : "user",
  content: [{ type: "text", text: `message ${i}` }],
  createdAt: new Date(0).toISOString(),
  finishReason: "stop",
});

describe("defaults", () => {
  test("are documented values generous enough for an interactive chat", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
    expect(DEFAULT_MAX_HISTORY_MESSAGES).toBe(1000);
    expect(DEFAULT_MAX_CONCURRENT_RUNS).toBe(5);
  });
});

describe("maxBodyBytes", () => {
  test("a body over the limit is a 413 before anything runs", async () => {
    const { controller, calls } = limited({ maxBodyBytes: 100 });
    const response = await send(controller, 1, { text: "x".repeat(200) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        kind: "form_error",
        status: 413,
        code: "body_too_large",
        message:
          "The request body is larger than this agent accepts (100 bytes).",
      },
    });
    expect(calls).toHaveLength(0);
  });

  test("a chunked body with no Content-Length is cut off while it is read", async () => {
    const { controller, calls } = limited({ maxBodyBytes: 2048 });
    const req = chunkedRequest(JSON.stringify({ text: "x".repeat(10_000) }));
    expect(req.rawRequest.headers.get("Content-Length")).toBeNull();
    const response = await as(1, req, () => controller().stream(req));
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("body_too_large");
    expect(calls).toHaveLength(0);
  });

  test("a chunked body under the limit is read whole", async () => {
    const { controller, calls, runs } = limited({ maxBodyBytes: 64 * 1024 });
    const req = chunkedRequest(JSON.stringify({ text: "é".repeat(3000) }));
    const response = await as(1, req, () => controller().stream(req));
    expect(response.status).toBe(200);
    expect(calls[0]?.turn).toMatchObject({ text: "é".repeat(3000) });
    runs[0]!.finish();
  });

  test("the default lets an ordinary turn through", async () => {
    const { controller, calls, runs } = limited();
    const response = await send(controller, 1, { text: "y".repeat(100_000) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    runs[0]!.finish();
  });

  test("attach and stop are held to a small body", async () => {
    const { controller } = limited();
    const big = { threadId: "t1", padding: "z".repeat(70 * 1024) };
    for (const route of ["attach", "stop"] as const) {
      const req = jsonRequest(big);
      const response = await as(1, req, () =>
        (controller() as any)[route](req),
      );
      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe("body_too_large");
    }
  });
});

describe("maxHistoryMessages", () => {
  test("a stateless history over the limit is a 413 before anything runs", async () => {
    const { controller, calls } = limited({ maxHistoryMessages: 3 });
    const response = await send(controller, 1, {
      messages: [0, 1, 2, 3].map(message),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        kind: "form_error",
        status: 413,
        code: "history_too_long",
        message: "The conversation has 4 messages; this agent takes at most 3.",
      },
    });
    expect(calls).toHaveLength(0);
  });

  test("a history at the limit runs", async () => {
    const { controller, calls, runs } = limited({ maxHistoryMessages: 3 });
    const response = await send(controller, 1, {
      messages: [0, 1, 2].map(message),
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.messages).toHaveLength(3);
    runs[0]!.finish();
  });

  test("a threaded turn's body messages are ignored, so they are not counted", async () => {
    const { controller, calls, runs } = limited({ maxHistoryMessages: 3 });
    const response = await send(controller, 1, {
      threadId: "t1",
      messages: [0, 1, 2, 3].map(message),
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    runs[0]!.finish();
  });
});

describe("maxConcurrentRuns", () => {
  test("a caller at the limit is refused a new conversation with a 429", async () => {
    const { controller, calls, runs } = limited({ maxConcurrentRuns: 2 });
    expect((await send(controller, 1, { threadId: "a" })).status).toBe(200);
    expect((await send(controller, 1, {})).status).toBe(200);

    const refused = await send(controller, 1, { threadId: "c" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: {
        kind: "rate_limit",
        status: 429,
        code: "too_many_runs",
        message:
          "You already have 2 conversations answering. Wait for one to finish, or stop it, and send again.",
      },
    });
    expect(calls).toHaveLength(2);
    for (const run of runs) run.finish();
  });

  test("a slot is freed when its run ends", async () => {
    const { controller, runs } = limited({ maxConcurrentRuns: 1 });
    expect((await send(controller, 1, { threadId: "a" })).status).toBe(200);
    expect((await send(controller, 1, { threadId: "b" })).status).toBe(429);

    runs[0]!.finish();
    await settle();
    expect((await send(controller, 1, { threadId: "b" })).status).toBe(200);
    runs[1]!.finish();
  });

  test("a new turn on a thread already answering is not an extra run", async () => {
    const { controller, runs } = limited({ maxConcurrentRuns: 1 });
    expect((await send(controller, 1, { threadId: "a" })).status).toBe(200);
    // Supersedes the first run rather than adding to it, so it is let in.
    const second = send(controller, 1, { threadId: "a", text: "again" });
    await settle();
    expect(runs[0]!.stopped).toBe(true);
    runs[0]!.finish();
    expect((await second).status).toBe(200);
    runs[1]!.finish();
  });

  test("counted per caller: another user is not affected", async () => {
    const { controller, runs } = limited({ maxConcurrentRuns: 1 });
    expect((await send(controller, 1, { threadId: "a" })).status).toBe(200);
    expect((await send(controller, 2, { threadId: "b" })).status).toBe(200);
    for (const run of runs) run.finish();
  });

  test("a refused or dead-thread turn does not keep a slot", async () => {
    const { controller, runs } = limited({ maxConcurrentRuns: 1 });
    const store = new MemoryAgentStore();
    const make = () => {
      const c = controller();
      c.store = store;
      return c;
    };
    // A thread the store does not know is a 404, with no run started.
    expect((await send(make, 1, { threadId: "missing" })).status).toBe(404);
    const thread = await store.createThread();
    expect((await send(make, 1, { threadId: thread })).status).toBe(200);
    runs[0]!.finish();
  });

  test("an anonymous turn is not counted by default", async () => {
    const { controller, runs } = limited({ maxConcurrentRuns: 1 });
    expect((await send(controller, null, {})).status).toBe(200);
    expect((await send(controller, null, {})).status).toBe(200);
    for (const run of runs) run.finish();
  });

  test("runLimitKey can count anonymous turns under a key of the app's", async () => {
    const { controller, runs } = limited({
      maxConcurrentRuns: 1,
      runLimitKey: (owner) => owner ?? "anon",
    });
    expect((await send(controller, null, {})).status).toBe(200);
    expect((await send(controller, null, {})).status).toBe(429);
    for (const run of runs) run.finish();
  });
});
