import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import type { ProviderEvent } from "../AgentProvider";
import { responsesEndpoint, streamResponses } from "./call";
import {
  azureTarget,
  DEFAULT_STREAM_MAX_DURATION_MS,
  openAITarget,
  type ProviderConfig,
} from "./endpoints";

/**
 * #1169: a stream that keeps trickling one tool call's arguments is cut at
 * `streamMaxDurationMs` (or `maxToolArgumentChars`), and an attempt that had
 * streamed nothing but unfinished arguments is asked again. Against a real
 * socket, as #1167's tests are.
 */

const LIMIT = 300;
const EMPTY = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const frame = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

const CREATED = frame({ type: "response.created", response: { model: "gpt-x" } });
const TEXT = frame({ type: "response.output_text.delta", delta: "ok" });
const COMPLETED = frame({
  type: "response.completed",
  response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
});

const callAdded = (n: number) =>
  frame({
    type: "response.output_item.added",
    item: { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "write" },
  });
const argDelta = (n: number, delta: string) =>
  frame({ type: "response.function_call_arguments.delta", item_id: `fc_${n}`, delta });
const argsDone = (n: number, args: string) =>
  frame({ type: "response.function_call_arguments.done", item_id: `fc_${n}`, arguments: args });

const HEADERS =
  "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";

type Respond = (socket: Socket) => void;

/** `head`, then `chunk` every `every` ms until the socket closes: never silent, never done. */
const trickles = (head: string[], chunk: string, every = 20): Respond => (socket) => {
  socket.write(HEADERS + head.join(""));
  const timer = setInterval(() => socket.write(chunk), every);
  socket.once("close", () => clearInterval(timer));
};

/** Sends the headers and `frames`, then nothing: the connection stays open. */
const stallsAfter = (...frames: string[]): Respond => (socket) => {
  socket.write(HEADERS + frames.join(""));
};

/** A whole answer with one completed call to `write`, then the connection closes. */
const callsWrite = (n: number): Respond => (socket) => {
  socket.end(
    HEADERS + CREATED + callAdded(n) + argDelta(n, '{"a":') + argDelta(n, "1}") + argsDone(n, '{"a":1}') + COMPLETED,
  );
};

const servers: { server: Server; sockets: Set<Socket> }[] = [];

/** A raw TCP server; connection `i` is answered by `script[i]` (the last repeats). */
async function tcpServer(script: Respond[]) {
  const sockets = new Set<Socket>();
  const closed: Promise<void>[] = [];
  let count = 0;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
    socket.on("error", () => {});
    const respond = script[Math.min(count++, script.length - 1)]!;
    socket.once("data", () => respond(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  servers.push({ server, sockets });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    connections: () => count,
    /** Resolves once every connection the server saw has been closed. */
    allClosed: () => Promise.all(closed),
  };
}

afterEach(async () => {
  for (const { server, sockets } of servers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function run(
  url: string,
  config: ProviderConfig = {},
  signal?: AbortSignal,
): Promise<{ events: ProviderEvent[]; ms: number }> {
  const endpoint = {
    ...responsesEndpoint(
      openAITarget({
        baseURL: url,
        apiKey: "k",
        streamIdleTimeoutMs: 0,
        streamMaxDurationMs: LIMIT,
        maxRetries: 0,
        ...config,
      }),
    ),
    // The backoff is not what is being measured.
    sleep: async () => {},
  };
  const start = performance.now();
  const events: ProviderEvent[] = [];
  for await (const event of streamResponses(endpoint, { model: "gpt-x", input: [] } as never, {
    structuredOutput: false,
    signal,
  })) {
    events.push(event);
  }
  return { events, ms: performance.now() - start };
}

const limitError = (name: string) => ({
  type: "error",
  error: expect.objectContaining({
    code: "provider_error",
    retryable: true,
    message: expect.stringContaining(name),
  }),
});

/** Everything but the runaway's own deltas, which arrive in whatever number the timer allows. */
const withoutDeltasOf = (events: ProviderEvent[], toolCallId: string) =>
  events.filter((e) => !(e.type === "tool-call-delta" && e.toolCallId === toolCallId));

const runaway = () => trickles([CREATED, callAdded(1)], argDelta(1, '{"title":"x"},'));

describe("streamResponses: streamMaxDurationMs (#1169)", () => {
  test("a call whose arguments trickle forever is cut at the limit, discarded and asked again, and the retry succeeds", async () => {
    const server = await tcpServer([runaway(), callsWrite(2)]);
    const { events, ms } = await run(server.url, { maxRetries: 1 });

    expect(server.connections()).toBe(2);
    // The runaway's deltas did reach the consumer, as they arrived.
    const runawayDeltas = events.filter((e) => e.type === "tool-call-delta" && e.toolCallId === "call_1");
    expect(runawayDeltas.length).toBeGreaterThan(3);
    expect(withoutDeltasOf(events, "call_1")).toEqual([
      { type: "tool-call-discard", toolCallIds: ["call_1"] },
      expect.objectContaining({ type: "retry", phase: "stream", attempt: 1, timedOut: true }),
      { type: "tool-call-delta", toolCallId: "call_2", name: "write", argsDelta: '{"a":' },
      { type: "tool-call-delta", toolCallId: "call_2", name: "write", argsDelta: "1}" },
      { type: "tool-call", toolCallId: "call_2", name: "write", args: '{"a":1}' },
      { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, model: "gpt-x" },
    ]);
    // The discard comes after every delta of the call it voids.
    const discardAt = events.findIndex((e) => e.type === "tool-call-discard");
    expect(events.slice(discardAt).some((e) => e.type === "tool-call-delta" && e.toolCallId === "call_1")).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(LIMIT - 20);
    expect(ms).toBeLessThan(LIMIT + 1500);
    await server.allClosed();
  });

  test("with no retry left, the partial call stays and the call ends with the limit's error", async () => {
    const server = await tcpServer([runaway()]);
    const { events } = await run(server.url, { maxRetries: 0 });

    expect(server.connections()).toBe(1);
    expect(events.some((e) => e.type === "tool-call-discard")).toBe(false);
    expect(withoutDeltasOf(events, "call_1")).toEqual([
      limitError("streamMaxDurationMs"),
      { type: "finish", reason: "error", usage: EMPTY },
    ]);
    await server.allClosed();
  });

  test("a cut after a completed text delta fails cleanly and is not retried", async () => {
    const server = await tcpServer([trickles([CREATED, TEXT, callAdded(1)], argDelta(1, "x")), callsWrite(2)]);
    const { events, ms } = await run(server.url, { maxRetries: 2 });

    expect(server.connections()).toBe(1);
    expect(withoutDeltasOf(events, "call_1")).toEqual([
      { type: "text-delta", delta: "ok" },
      limitError("streamMaxDurationMs"),
      { type: "finish", reason: "error", usage: EMPTY },
    ]);
    expect(ms).toBeLessThan(LIMIT + 1500);
    await server.allClosed();
  });

  test("a steady text answer is cut at the limit too: no chunk resets it", async () => {
    const server = await tcpServer([trickles([CREATED], TEXT)]);
    const { events } = await run(server.url, { maxRetries: 2, streamIdleTimeoutMs: LIMIT * 10 });

    expect(server.connections()).toBe(1);
    expect(events.at(-2)).toEqual(limitError("streamMaxDurationMs"));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "error", usage: EMPTY });
    await server.allClosed();
  });

  test("the caller's signal still wins: aborted, nothing discarded, and the socket is released", async () => {
    const server = await tcpServer([runaway()]);
    const { events, ms } = await run(server.url, { maxRetries: 2 }, AbortSignal.timeout(LIMIT / 2));

    expect(server.connections()).toBe(1);
    expect(withoutDeltasOf(events, "call_1")).toEqual([{ type: "finish", reason: "aborted", usage: EMPTY }]);
    expect(ms).toBeLessThan(LIMIT);
    await server.allClosed();
  });

  test("`0` turns it off", async () => {
    const server = await tcpServer([runaway()]);
    const { events, ms } = await run(
      server.url,
      { streamMaxDurationMs: 0, maxRetries: 2 },
      AbortSignal.timeout(LIMIT * 3),
    );

    expect(server.connections()).toBe(1);
    expect(withoutDeltasOf(events, "call_1")).toEqual([{ type: "finish", reason: "aborted", usage: EMPTY }]);
    expect(ms).toBeGreaterThanOrEqual(LIMIT * 3 - 20);
  });
});

describe("streamResponses: a break after only tool-call arguments is retried (#1169)", () => {
  test("the idle limit cutting a call mid-arguments: discarded and asked again", async () => {
    const server = await tcpServer([stallsAfter(CREATED, callAdded(1), argDelta(1, '{"a"')), callsWrite(2)]);
    const { events } = await run(server.url, {
      streamMaxDurationMs: 0,
      streamIdleTimeoutMs: LIMIT / 2,
      maxRetries: 1,
    });

    expect(server.connections()).toBe(2);
    expect(events.map((e) => e.type)).toEqual([
      "tool-call-delta",
      "tool-call-discard",
      "retry",
      "tool-call-delta",
      "tool-call-delta",
      "tool-call",
      "finish",
    ]);
    expect(events[1]).toEqual({ type: "tool-call-discard", toolCallIds: ["call_1"] });
    await server.allClosed();
  });

  test("usage the dropped attempt reported is added to the retry's finish", async () => {
    const failed = frame({
      type: "response.failed",
      response: {
        error: { code: "server_error", message: "boom" },
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    });
    const server = await tcpServer([
      (socket) => socket.end(HEADERS + CREATED + callAdded(1) + argDelta(1, "{") + failed),
      callsWrite(2),
    ]);
    const { events } = await run(server.url, { maxRetries: 1 });

    expect(server.connections()).toBe(2);
    expect(events.filter((e) => e.type === "tool-call-discard")).toEqual([
      { type: "tool-call-discard", toolCallIds: ["call_1"] },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    const finish = events.at(-1) as Extract<ProviderEvent, { type: "finish" }>;
    expect(finish.usage.inputTokens).toBeGreaterThanOrEqual(10);
  });
});

describe("streamResponses: maxToolArgumentChars (#1169)", () => {
  test("a call past the cap is cut as a runaway, discarded and asked again", async () => {
    const server = await tcpServer([runaway(), callsWrite(2)]);
    const { events, ms } = await run(server.url, {
      streamMaxDurationMs: 0,
      maxToolArgumentChars: 100,
      maxRetries: 1,
    });

    expect(server.connections()).toBe(2);
    const runawayChars = events
      .filter((e) => e.type === "tool-call-delta" && e.toolCallId === "call_1")
      .reduce((sum, e) => sum + (e as { argsDelta: string }).argsDelta.length, 0);
    // The delta that crossed the cap was not passed on.
    expect(runawayChars).toBeLessThanOrEqual(100);
    expect(withoutDeltasOf(events, "call_1").map((e) => e.type)).toEqual([
      "tool-call-discard",
      "retry",
      "tool-call-delta",
      "tool-call-delta",
      "tool-call",
      "finish",
    ]);
    expect(ms).toBeLessThan(LIMIT * 3);
    await server.allClosed();
  });

  test("with no retry left it ends the call with an error that names the tool", async () => {
    const server = await tcpServer([runaway()]);
    const { events } = await run(server.url, { streamMaxDurationMs: 0, maxToolArgumentChars: 100 });

    expect(withoutDeltasOf(events, "call_1")).toEqual([
      limitError('"write"'),
      { type: "finish", reason: "error", usage: EMPTY },
    ]);
    await server.allClosed();
  });

  test("a call that finishes under the cap is untouched", async () => {
    const server = await tcpServer([callsWrite(1)]);
    const { events } = await run(server.url, { maxToolArgumentChars: 7 });

    expect(events.map((e) => e.type)).toEqual(["tool-call-delta", "tool-call-delta", "tool-call", "finish"]);
  });
});

describe("streamMaxDurationMs / maxToolArgumentChars config", () => {
  test("defaults on both vendors, overridable", () => {
    expect(DEFAULT_STREAM_MAX_DURATION_MS).toBe(300_000);
    expect(openAITarget({}).streamMaxDurationMs).toBe(DEFAULT_STREAM_MAX_DURATION_MS);
    expect(azureTarget({ endpoint: "https://r.openai.azure.com" }).streamMaxDurationMs).toBe(
      DEFAULT_STREAM_MAX_DURATION_MS,
    );
    expect(openAITarget({}).maxToolArgumentChars).toBe(0);
    expect(azureTarget({}).maxToolArgumentChars).toBe(0);
    const endpoint = responsesEndpoint(openAITarget({ streamMaxDurationMs: 5_000, maxToolArgumentChars: 9 }));
    expect(endpoint.streamMaxDurationMs).toBe(5_000);
    expect(endpoint.maxToolArgumentChars).toBe(9);
    expect(responsesEndpoint(azureTarget({ streamMaxDurationMs: 0 })).streamMaxDurationMs).toBe(0);
  });
});
