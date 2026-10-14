import { describe, expect, test } from "vitest";

import type { ProviderEvent } from "../AgentProvider";
import {
  responsesEndpoint,
  streamResponses,
  type ResponsesEndpoint,
} from "./call";
import type { FetchLike } from "./http";

/**
 * #946: a Responses stream whose response started and then died before its
 * first content event is asked again, with the request retry's backoff.
 */

const frame = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

const CREATED = frame({
  type: "response.created",
  response: { model: "gpt-x" },
});
const DELTA = frame({ type: "response.output_text.delta", delta: "ok" });
const COMPLETED = frame({
  type: "response.completed",
  response: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
});

/** A 200 whose body sends `frames`, then either ends or breaks the socket. */
function sse(
  frames: string[],
  end: "close" | "drop" = "close",
): () => Response {
  return () => {
    const encoder = new TextEncoder();
    const queue = [...frames];
    // One frame per pull, and the drop on the pull after the last: an error
    // raised up front would discard the frames still queued.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();
        if (next !== undefined) controller.enqueue(encoder.encode(next));
        else if (end === "drop") {
          controller.error(
            new TypeError("The socket connection was closed unexpectedly."),
          );
        } else controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

const OK = sse([CREATED, DELTA, COMPLETED]);
const DROPPED = sse([CREATED], "drop");

function harness(
  script: Array<() => Response>,
  options: { maxRetries?: number } = {},
) {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = async () =>
    script[Math.min(calls++, script.length - 1)]!();
  const endpoint: ResponsesEndpoint = {
    ...responsesEndpoint({
      base: "https://api.example/v1",
      query: "",
      headers: async () => ({ authorization: "Bearer k" }),
      timeoutMs: 0,
      maxRetries: options.maxRetries ?? 2,
    } as never),
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  };
  return {
    endpoint,
    sleeps,
    calls: () => calls,
    async run(signal?: AbortSignal) {
      const events: ProviderEvent[] = [];
      for await (const event of streamResponses(
        endpoint,
        { model: "gpt-x", input: [] } as never,
        {
          structuredOutput: false,
          signal,
        },
      )) {
        events.push(event);
      }
      return events;
    },
  };
}

describe("streamResponses: a stream that dies before its first event (#946)", () => {
  test("drops once, then succeeds: the user sees one clean answer", async () => {
    const h = harness([DROPPED, OK]);
    const events = await h.run();
    expect(h.calls()).toBe(2);
    expect(events).toEqual([
      { type: "text-delta", delta: "ok" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        model: "gpt-x",
      },
    ]);
    // The request retry's backoff: 500ms floor, halved by `random: () => 0`.
    expect(h.sleeps).toEqual([250]);
  });

  test("drops every time: ends in a retryable error after `maxRetries` retries", async () => {
    const h = harness([DROPPED], { maxRetries: 2 });
    const events = await h.run();
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([250, 500]);
    expect(events).toEqual([
      {
        type: "error",
        error: expect.objectContaining({
          code: "provider_error",
          retryable: true,
        }),
      },
      {
        type: "finish",
        reason: "error",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  test("a stream that ends with no terminal frame is retried too", async () => {
    const h = harness([sse([CREATED]), OK]);
    const events = await h.run();
    expect(h.calls()).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "finish"]);
  });

  test("an in-stream 5xx-type `response.failed` is retried, and its usage is kept", async () => {
    const failed = sse([
      CREATED,
      frame({
        type: "response.failed",
        response: {
          error: { code: "server_error", message: "The server had an error." },
          usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
        },
      }),
    ]);
    const h = harness([failed, OK]);
    const events = await h.run();
    expect(h.calls()).toBe(2);
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 17, outputTokens: 1, totalTokens: 18 },
      model: "gpt-x",
    });
  });

  test("a non-retryable in-stream error is not retried", async () => {
    const tooLong = sse([
      frame({
        type: "response.failed",
        response: {
          error: { code: "context_length_exceeded", message: "Too long." },
        },
      }),
    ]);
    const h = harness([tooLong, OK]);
    const events = await h.run();
    expect(h.calls()).toBe(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { code: "context_length_exceeded" },
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });

  test("never retried once output has been emitted", async () => {
    const h = harness([sse([CREATED, DELTA], "drop"), OK]);
    const events = await h.run();
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(events).toEqual([
      { type: "text-delta", delta: "ok" },
      {
        type: "error",
        error: expect.objectContaining({
          code: "provider_error",
          retryable: true,
        }),
      },
      {
        type: "finish",
        reason: "error",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  test("`maxRetries: 0` turns the stream retry off as well", async () => {
    const h = harness([DROPPED, OK], { maxRetries: 0 });
    const events = await h.run();
    expect(h.calls()).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["error", "finish"]);
  });

  test("an abort during the backoff ends the call at once, with no error", async () => {
    const controller = new AbortController();
    const h = harness([DROPPED, OK]);
    h.endpoint.sleep = (_ms, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        controller.abort();
      });
    const events = await h.run(controller.signal);
    expect(h.calls()).toBe(1);
    expect(events).toEqual([
      {
        type: "finish",
        reason: "aborted",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  test("an already-aborted signal is not retried", async () => {
    const controller = new AbortController();
    const h = harness([DROPPED, OK]);
    const fetchImpl = h.endpoint.fetchImpl!;
    h.endpoint.fetchImpl = async (url, init) => {
      const response = await fetchImpl(url, init);
      controller.abort();
      return response;
    };
    const events = await h.run(controller.signal);
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(events).toEqual([
      {
        type: "finish",
        reason: "aborted",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });
});
