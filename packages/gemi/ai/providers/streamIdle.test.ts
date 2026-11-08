import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import type { ProviderEvent } from "../AgentProvider";
import { responsesEndpoint, streamResponses } from "./call";
import {
  azureTarget,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  openAITarget,
  type ProviderConfig,
} from "./endpoints";

/**
 * #1167: a streamed answer that started and then went silent is cut at
 * `streamIdleTimeoutMs`, against a real socket so the release of the
 * connection is what is asserted, not a mock's idea of it.
 */

const LIMIT = 200;

const frame = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

const CREATED = frame({ type: "response.created", response: { model: "gpt-x" } });
const DELTA = frame({ type: "response.output_text.delta", delta: "ok" });
const COMPLETED = frame({
  type: "response.completed",
  response: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
});

const HEADERS =
  "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";

type Respond = (socket: Socket) => void;

/** Sends the headers and `frames`, then nothing: the connection stays open. */
const stallsAfter = (...frames: string[]): Respond => (socket) => {
  socket.write(HEADERS + frames.join(""));
};

/** A whole answer, then the connection closes. */
const answers: Respond = (socket) => {
  socket.end(HEADERS + CREATED + DELTA + COMPLETED);
};

/** `frames` one every `every` ms, then the end. */
const steady = (frames: string[], every: number): Respond => (socket) => {
  socket.write(HEADERS);
  const queue = [...frames];
  const timer = setInterval(() => {
    const next = queue.shift();
    if (next === undefined) {
      clearInterval(timer);
      socket.end();
    } else socket.write(next);
  }, every);
  socket.once("close", () => clearInterval(timer));
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
      openAITarget({ baseURL: url, apiKey: "k", streamIdleTimeoutMs: LIMIT, maxRetries: 0, ...config }),
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

const idleError = {
  type: "error",
  error: expect.objectContaining({
    code: "provider_error",
    retryable: true,
    message: expect.stringContaining("streamIdleTimeoutMs"),
  }),
};

describe("streamResponses: streamIdleTimeoutMs (#1167)", () => {
  test("headers and an event, then silence: a retryable error at about the limit, and the socket is released", async () => {
    const server = await tcpServer([stallsAfter(CREATED)]);
    const { events, ms } = await run(server.url);

    expect(events).toEqual([
      idleError,
      { type: "finish", reason: "error", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ]);
    expect(ms).toBeGreaterThanOrEqual(LIMIT - 20);
    expect(ms).toBeLessThan(LIMIT + 1000);
    expect(server.connections()).toBe(1);
    await server.allClosed();
  });

  test("a stall before the first content event is asked again", async () => {
    const server = await tcpServer([stallsAfter(CREATED), answers]);
    const { events } = await run(server.url, { maxRetries: 1 });

    expect(server.connections()).toBe(2);
    expect(events).toEqual([
      expect.objectContaining({ type: "retry", phase: "stream", attempt: 1, timedOut: true }),
      { type: "text-delta", delta: "ok" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        model: "gpt-x",
      },
    ]);
    await server.allClosed();
  });

  test("a stall after output ends the call with the error and is not retried", async () => {
    const server = await tcpServer([stallsAfter(CREATED, DELTA), answers]);
    const { events, ms } = await run(server.url, { maxRetries: 2 });

    expect(server.connections()).toBe(1);
    expect(events).toEqual([
      { type: "text-delta", delta: "ok" },
      idleError,
      { type: "finish", reason: "error", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ]);
    expect(ms).toBeLessThan(LIMIT + 1000);
    await server.allClosed();
  });

  test("a slow but steady stream longer than the limit completes", async () => {
    const deltas = Array.from({ length: 6 }, () => DELTA);
    const server = await tcpServer([steady([CREATED, ...deltas, COMPLETED], LIMIT / 3)]);
    const { events, ms } = await run(server.url);

    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    expect(ms).toBeGreaterThan(LIMIT * 2);
  });

  test("keepalive comments count as a sign of life", async () => {
    const keepalives = Array.from({ length: 6 }, () => ": keepalive\n\n");
    const server = await tcpServer([steady([CREATED, ...keepalives, DELTA, COMPLETED], LIMIT / 3)]);
    const { events } = await run(server.url);

    expect(events.map((e) => e.type)).toEqual(["text-delta", "finish"]);
  });

  test("the caller's abort wins: aborted, not a timeout, and the socket is released", async () => {
    const server = await tcpServer([stallsAfter(CREATED)]);
    const { events, ms } = await run(
      server.url,
      { streamIdleTimeoutMs: LIMIT * 10, maxRetries: 2 },
      AbortSignal.timeout(LIMIT / 2),
    );

    expect(events).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ]);
    expect(ms).toBeLessThan(LIMIT * 5);
    expect(server.connections()).toBe(1);
    await server.allClosed();
  });

  test("`0` turns it off", async () => {
    const server = await tcpServer([stallsAfter(CREATED)]);
    const { events, ms } = await run(
      server.url,
      { streamIdleTimeoutMs: 0 },
      AbortSignal.timeout(LIMIT * 3),
    );

    expect(events).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ]);
    expect(ms).toBeGreaterThanOrEqual(LIMIT * 3 - 20);
  });
});

describe("streamIdleTimeoutMs config", () => {
  test("defaults to DEFAULT_STREAM_IDLE_TIMEOUT_MS on both vendors and is overridable", () => {
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(openAITarget({}).streamIdleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    expect(azureTarget({ endpoint: "https://r.openai.azure.com" }).streamIdleTimeoutMs).toBe(
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    );
    expect(responsesEndpoint(openAITarget({ streamIdleTimeoutMs: 5_000 })).streamIdleTimeoutMs).toBe(5_000);
    expect(responsesEndpoint(azureTarget({ streamIdleTimeoutMs: 0 })).streamIdleTimeoutMs).toBe(0);
  });
});
