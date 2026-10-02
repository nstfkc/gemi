import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../facades/Log", () => ({ Log: { error: logged.error } }));

import { Agent, AgentRunError } from "./Agent";
import { OpenAIProvider, type AgentProvider, type ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentStreamEvent } from "./types";

/**
 * #656: a run that fails says why on `result()`, logs it, and still tells the
 * client no more than it did before.
 *
 * The two failures kyte hit are the first two tests, through the real OpenAI
 * provider with `fetch` replaced: an endpoint nothing answers on, and a 400 for
 * a parameter the model refuses. Both used to resolve `result()` with
 * `finishReason: "error"`, no output and nothing else, and log nothing.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
  logged.error.mockReset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const TEMPERATURE_400 = {
  error: {
    message: "Unsupported parameter: 'temperature' is not supported with this model.",
    type: "invalid_request_error",
    param: "temperature",
    code: "unsupported_parameter",
  },
};

function unreachable() {
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
}

function rejectsTemperature() {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(TEMPERATURE_400), {
        status: 400,
        headers: { "content-type": "application/json", "x-request-id": "req_abc123" },
      }),
  ) as unknown as typeof fetch;
}

function answers(text: string) {
  const sse = [
    ["response.output_text.delta", { type: "response.output_text.delta", delta: text }],
    [
      "response.completed",
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
    ],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  globalThis.fetch = vi.fn(async () => new Response(sse)) as unknown as typeof fetch;
}

function agent(params: { provider?: AgentProvider; logErrors?: boolean } = {}) {
  return Agent.create({
    name: "director",
    instructions: "Be brief.",
    provider: params.provider ?? OpenAIProvider.model("gpt-5.4", { apiKey: "k", maxRetries: 0 }),
    temperature: 0.7,
    ...(params.logErrors === undefined ? {} : { logErrors: params.logErrors }),
  });
}

async function events(run: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const seen: AgentStreamEvent[] = [];
  for await (const event of run) seen.push(event);
  return seen;
}

async function sseFrames(response: Response): Promise<any[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

describe("a provider that cannot be reached", () => {
  test("result() resolves with the cause on `error`", async () => {
    unreachable();
    const result = await agent()
      .stream({ messages: [], turn: { text: "hi" } })
      .result();

    expect(result.finishReason).toBe("error");
    expect(result.output).toBeUndefined();
    expect(result.error).toEqual({
      code: "provider_error",
      message: "Could not reach the provider: fetch failed",
      retryable: true,
    });
  });

  test("is logged through the app's logger", async () => {
    unreachable();
    const run = agent().stream({ messages: [], turn: { text: "hi" }, threadId: "t1" });
    await run.result();

    expect(logged.error).toHaveBeenCalledTimes(1);
    const [message, metadata] = logged.error.mock.calls[0]!;
    expect(message).toContain('agent "director"');
    expect(message).toContain("Could not reach the provider: fetch failed");
    expect(metadata).toMatchObject({
      agent: "director",
      runId: run.runId,
      threadId: "t1",
      error: { code: "provider_error", retryable: true },
    });
  });

  test("result({ throwOnError: true }) rejects with an AgentRunError carrying the result", async () => {
    unreachable();
    const run = agent().stream({ messages: [], turn: { text: "hi" } });
    const error = await run.result({ throwOnError: true }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AgentRunError);
    const failure = error as AgentRunError;
    expect(failure.message).toBe("Could not reach the provider: fetch failed");
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
    expect(failure.status).toBeUndefined();
    expect(failure.runId).toBe(run.runId);
    // Steps before the failure are not lost to the rejection: the user's turn
    // and the closed assistant message are still there to persist.
    expect(failure.result.finishReason).toBe("error");
    expect(failure.result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // And the plain call on the same run still resolves.
    await expect(run.result()).resolves.toMatchObject({ finishReason: "error" });
  });
});

describe("a provider that answers 400", () => {
  test("result().error has the provider's message, the status and the request id", async () => {
    rejectsTemperature();
    const result = await agent()
      .stream({ messages: [], turn: { text: "hi" } })
      .result();

    expect(result.finishReason).toBe("error");
    expect(result.error).toEqual({
      code: "provider_error",
      message: "Unsupported parameter: 'temperature' is not supported with this model.",
      retryable: false,
      status: 400,
      requestId: "req_abc123",
    });
    expect(logged.error).toHaveBeenCalledTimes(1);
    expect(logged.error.mock.calls[0]![0]).toContain("(provider_error 400)");
    expect(logged.error.mock.calls[0]![1]).toMatchObject({ error: { status: 400 } });
  });

  test("throwOnError carries the status", async () => {
    rejectsTemperature();
    const error = await agent()
      .stream({ messages: [], turn: { text: "hi" } })
      .result({ throwOnError: true })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AgentRunError);
    expect((error as AgentRunError).status).toBe(400);
    expect((error as AgentRunError).requestId).toBe("req_abc123");
  });

  test("a status thrown by a custom provider reaches the result too", async () => {
    // A provider that throws instead of yielding an error event, with its own
    // SDK's error class: read by shape, not by `instanceof ProviderHttpError`.
    const provider = {
      model: "custom",
      capabilities: fakeProvider().capabilities,
      stream(): AsyncIterable<ProviderEvent> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(Object.assign(new Error("Bad request"), { status: 422 })),
          }),
        };
      },
      normalizeError: (error: unknown) => ({
        code: "provider_error" as const,
        message: (error as Error).message,
        retryable: false,
      }),
    } as unknown as AgentProvider;

    const result = await agent({ provider }).stream({ messages: [] }).result();
    expect(result.error).toEqual({
      code: "provider_error",
      message: "Bad request",
      retryable: false,
      status: 422,
    });
  });
});

describe("the client's copy of a failure", () => {
  test("the error frame carries the AgentError fields and nothing server-side", async () => {
    rejectsTemperature();
    const run = agent().stream({ messages: [], turn: { text: "hi" } });
    const seen = await events(run);

    const errors = seen.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    // No status, no request id (#656), and not the provider's own sentence
    // either (#446): that stays on `result().error` and in the log.
    expect((errors[0] as { error: unknown }).error).toStrictEqual({
      code: "provider_error",
      message: "The model provider returned an error.",
      retryable: false,
    });
  });

  test("the SSE response never mentions the status or the request id", async () => {
    rejectsTemperature();
    const run = agent().stream({ messages: [], turn: { text: "hi" } });
    const response = run.toResponse();
    await run.result();
    const frames = await sseFrames(response);

    const error = frames.find((frame) => frame.type === "error");
    expect(Object.keys(error.error).sort()).toEqual(["code", "message", "retryable"]);
    expect(JSON.stringify(frames)).not.toContain("req_abc123");
    expect(JSON.stringify(frames)).not.toContain('"status"');
  });
});

describe("a run that succeeds", () => {
  test("has no `error` key, logs nothing, and throwOnError resolves", async () => {
    answers("Hello");
    const run = agent().stream({ messages: [], turn: { text: "hi" } });
    const result = await run.result();

    expect(result.finishReason).toBe("stop");
    expect("error" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual([
      "finishReason",
      "messages",
      "output",
      "runId",
      "usage",
    ]);
    await expect(run.result({ throwOnError: true })).resolves.toBe(result);
    expect(logged.error).not.toHaveBeenCalled();
  });

  test("a stopped run is not a failure: no error, no log, no rejection", async () => {
    answers("Hello");
    const controller = new AbortController();
    controller.abort();
    const run = agent().stream({ messages: [], signal: controller.signal });
    const result = await run.result({ throwOnError: true });

    expect(result.finishReason).toBe("aborted");
    expect(result.error).toBeUndefined();
    expect(logged.error).not.toHaveBeenCalled();
  });
});

describe("logging", () => {
  test("logErrors: false keeps it out of the log", async () => {
    unreachable();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await agent({ logErrors: false })
      .stream({ messages: [], turn: { text: "hi" } })
      .result();

    expect(result.error?.code).toBe("provider_error");
    expect(logged.error).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("with no application to log through, it goes to the console instead", async () => {
    unreachable();
    logged.error.mockImplementation(() => {
      throw new Error("No Application instance is available.");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await agent()
      .stream({ messages: [], turn: { text: "hi" } })
      .result();

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("Could not reach the provider");
  });

  test("a provider error event mid-stream is logged once", async () => {
    const provider = fakeProvider([
      { type: "error", error: { code: "content_filtered", message: "blocked", retryable: false } },
      {
        type: "finish",
        reason: "error",
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      },
    ]);
    const result = await agent({ provider }).stream({ messages: [] }).result();

    expect(result.error).toEqual({
      code: "content_filtered",
      message: "blocked",
      retryable: false,
    });
    expect(logged.error).toHaveBeenCalledTimes(1);
  });
});
