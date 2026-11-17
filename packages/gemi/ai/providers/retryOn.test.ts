import { describe, expect, test, vi } from "vitest";

import type { ProviderEvent, ProviderRetryInfo } from "../AgentProvider";
import { responsesEndpoint, streamResponses, type ResponsesEndpoint } from "./call";
import { openAITarget } from "./endpoints";
import { requestWithRetry, type FetchLike, type ProviderRetryPolicy } from "./http";

/**
 * #1291: a cut call's `retry` event says it was cut, an agent that sends cuts
 * back to the model is not made to wait for them, and a retry policy can wait
 * out only some failures (`retry.on`).
 */

const res = (status: number, body = "") => new Response(body, { status });

function clocked() {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
}

async function request(
  script: Array<number | "timeout">,
  retry: ProviderRetryPolicy,
  maxRetries = 0,
) {
  const time = clocked();
  const seen: Omit<ProviderRetryInfo, "phase">[] = [];
  let calls = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const next = script[Math.min(calls++, script.length - 1)]!;
    if (next === "timeout") {
      // Hangs until `timeoutMs` aborts the attempt.
      return await new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    }
    return res(next);
  };
  const outcome = await requestWithRetry(
    "https://api.example/responses",
    { method: "POST" },
    {
      maxRetries,
      timeoutMs: script.includes("timeout") ? 5 : 0,
      fetchImpl,
      sleep: time.sleep,
      random: () => 0,
      now: time.now,
      onRetry: (info) => seen.push(info),
      retry,
    },
  ).then(
    (response) => ({ status: response.status }),
    (error: unknown) => ({ error }),
  );
  return { outcome, seen, calls: () => calls };
}

describe("retry.on: which failures are waited out", () => {
  test("a list of codes waits out those and fails the others after the quick retries", async () => {
    const policy = { patienceMs: 60_000, on: ["rate_limited"] } as const;

    const limited = await request([429, 429, 200], policy);
    expect(limited.outcome).toEqual({ status: 200 });
    expect(limited.calls()).toBe(3);

    const down = await request([503, 200], policy, 1);
    // The quick retry is unaffected; no patient retry follows it.
    expect(down.outcome).toEqual({ status: 200 });
    const stillDown = await request([503], policy, 1);
    expect(stillDown.calls()).toBe(2);
    expect((stillDown.outcome as { error: { status: number } }).error.status).toBe(503);
  });

  test("a function is told the status and whether the attempt timed out", async () => {
    const asked: unknown[] = [];
    const policy: ProviderRetryPolicy = {
      patienceMs: 60_000,
      on: (error, failure) => {
        asked.push({ code: error.code, ...failure });
        return !failure.timedOut;
      },
    };

    const limited = await request([429, 200], policy);
    expect(limited.outcome).toEqual({ status: 200 });
    expect(asked[0]).toEqual({ code: "rate_limited", status: 429, timedOut: false });

    asked.length = 0;
    const stuck = await request(["timeout", 200], policy);
    expect("error" in stuck.outcome).toBe(true);
    expect(stuck.calls()).toBe(1);
    expect(asked[0]).toMatchObject({ code: "provider_error", timedOut: true });
  });

  test("a function that throws is a no", async () => {
    const { outcome, calls } = await request([429, 200], {
      patienceMs: 60_000,
      on: () => {
        throw new Error("boom");
      },
    });
    expect("error" in outcome).toBe(true);
    expect(calls()).toBe(1);
  });

  test("a failure that is not retryable is never waited out, whatever on says", async () => {
    const { calls } = await request([400, 200], { patienceMs: 60_000, on: () => true });
    expect(calls()).toBe(1);
  });

  test("a policy whose on is neither a list nor a function is refused", () => {
    expect(() => openAITarget({ retry: { patienceMs: 1_000, on: "rate_limited" } } as never)).toThrow(/retry/);
    expect(() => openAITarget({ retry: { patienceMs: 1_000, on: [1] } } as never)).toThrow(/retry/);
    expect(() => openAITarget({ retry: { patienceMs: 1_000, on: ["rate_limited"] } })).not.toThrow();
  });
});

describe("streamResponses: a cut call", () => {
  const frame = (payload: Record<string, unknown>) =>
    `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
  const sse = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  /** One call to `write` whose arguments run past 100 characters. */
  const RUNAWAY = () =>
    sse(
      frame({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write" },
      }) +
        frame({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: `{"body":"${"a".repeat(120)}` }),
    );
  const OK = () =>
    sse(
      frame({ type: "response.output_text.delta", delta: "ok" }) +
        frame({
          type: "response.completed",
          response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        }),
    );
  const DROPPED = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new TypeError("The socket connection was closed unexpectedly."));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  function endpoint(script: Array<() => Response>, options: { maxRetries?: number; retry?: ProviderRetryPolicy } = {}) {
    const time = clocked();
    let calls = 0;
    const value: ResponsesEndpoint = {
      ...responsesEndpoint({
        base: "https://api.example/v1",
        query: "",
        headers: async () => ({}),
        timeoutMs: 0,
        maxRetries: options.maxRetries ?? 0,
        maxToolArgumentChars: 100,
        ...(options.retry ? { retry: options.retry } : {}),
      } as never),
      fetchImpl: async () => script[Math.min(calls++, script.length - 1)]!(),
      sleep: time.sleep,
      random: () => 0,
      now: time.now,
    };
    return { value, calls: () => calls };
  }

  async function collect(endpoint: ResponsesEndpoint, retryToolArgumentsTooLong?: boolean) {
    const events: ProviderEvent[] = [];
    for await (const event of streamResponses(endpoint, { model: "m", input: [] } as never, {
      structuredOutput: false,
      ...(retryToolArgumentsTooLong !== undefined ? { retryToolArgumentsTooLong } : {}),
    })) {
      events.push(event);
    }
    return events;
  }

  const CUT = { tool: "write", toolCallId: "call_1", limit: 100, chars: expect.any(Number) };

  test("its retry event carries toolArgumentsTooLong, the same as the error event", async () => {
    const e = endpoint([RUNAWAY, OK], { maxRetries: 1 });
    const events = await collect(e.value);
    expect(e.calls()).toBe(2);
    expect(events.find((event) => event.type === "retry")).toMatchObject({
      phase: "stream",
      toolArgumentsTooLong: CUT,
    });
  });

  test("a retry for any other failure has no toolArgumentsTooLong", async () => {
    const e = endpoint([DROPPED, OK], { maxRetries: 1 });
    const events = await collect(e.value);
    const retry = events.find((event) => event.type === "retry") as ProviderRetryInfo;
    expect(retry).toBeDefined();
    expect(retry.toolArgumentsTooLong).toBeUndefined();
  });

  test("retryToolArgumentsTooLong: false ends the call with the cut at once", async () => {
    const e = endpoint([RUNAWAY, OK], { maxRetries: 2, retry: { patienceMs: 60_000 } });
    const events = await collect(e.value, false);
    expect(e.calls()).toBe(1);
    expect(events.some((event) => event.type === "retry")).toBe(false);
    expect(events.find((event) => event.type === "error")).toMatchObject({ toolArgumentsTooLong: CUT });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });

  test("other failures are still retried with retryToolArgumentsTooLong: false", async () => {
    const e = endpoint([DROPPED, OK], { maxRetries: 1 });
    const events = await collect(e.value, false);
    expect(e.calls()).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  test("retry.on is told about the cut, and can leave it out of the patient retries", async () => {
    const told: unknown[] = [];
    const e = endpoint([RUNAWAY, RUNAWAY, OK], {
      maxRetries: 1,
      retry: {
        patienceMs: 60_000,
        on: (_error, failure) => {
          told.push(failure);
          return !failure.toolArgumentsTooLong;
        },
      },
    });
    const events = await collect(e.value);
    // One quick retry, then no patient one.
    expect(e.calls()).toBe(2);
    expect(told).toEqual([{ timedOut: false, toolArgumentsTooLong: CUT }]);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });

  test("retry.on as a list applies to stream failures too", async () => {
    const e = endpoint([DROPPED, DROPPED, OK], { retry: { patienceMs: 60_000, on: ["rate_limited"] } });
    const events = await collect(e.value);
    expect(e.calls()).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });
});

describe("Agent", () => {
  const finish = (reason: "stop" | "error" = "stop"): ProviderEvent => ({
    type: "finish",
    reason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  const cut = (toolCallId: string): ProviderEvent[] => [
    { type: "tool-call-delta", toolCallId, name: "write", argsDelta: '{"body":"aaaa' },
    {
      type: "error",
      error: { code: "provider_error", message: "cut", retryable: true },
      toolArgumentsTooLong: { tool: "write", toolCallId, limit: 100, chars: 104 },
    },
    finish("error"),
  ];

  async function writer(scripts: ProviderEvent[][], onToolArgumentsTooLong?: { toolError: number }) {
    const { Agent, AgentTool } = await import("../Agent");
    const { fakeProvider } = await import("./fakeProvider");
    const { s } = await import("../Schema");
    const provider = fakeProvider(...scripts);
    const agent = Agent.create({
      name: "writer",
      provider,
      tools: [
        AgentTool.create({
          name: "write",
          description: "Write",
          inputSchema: s.object({ body: s.string() }),
          execute: async () => ({ ok: true }),
        }),
      ],
      ...(onToolArgumentsTooLong ? { onToolArgumentsTooLong } : {}),
    });
    return { agent, provider };
  }

  test("asks the provider not to retry a cut while its toolError budget lasts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, provider } = await writer([cut("c1"), cut("c2"), [{ type: "text-delta", delta: "ok" }, finish()]], {
      toolError: 1,
    });
    await agent.stream({ messages: [], turn: { text: "write" } }).result();
    expect(provider.calls[0]!.retryToolArgumentsTooLong).toBe(false);
    // The budget is spent: the next cut fails the run, so retrying it first is fine.
    expect(provider.calls[1]!.retryToolArgumentsTooLong).toBeUndefined();
  });

  test("without onToolArgumentsTooLong the provider retries cuts as before", async () => {
    const { agent, provider } = await writer([[{ type: "text-delta", delta: "ok" }, finish()]]);
    await agent.stream({ messages: [], turn: { text: "write" } }).result();
    expect(provider.calls[0]!.retryToolArgumentsTooLong).toBeUndefined();
  });

  test("onProviderRetry gets toolArgumentsTooLong", async () => {
    const retry: ProviderEvent = {
      type: "retry",
      attempt: 1,
      maxRetries: 2,
      error: { code: "provider_error", message: "cut", retryable: true },
      phase: "stream",
      timedOut: false,
      delayMs: 500,
      elapsedMs: 900,
      toolArgumentsTooLong: { tool: "write", toolCallId: "c1", limit: 100, chars: 104 },
    };
    const { agent } = await writer([[retry, { type: "text-delta", delta: "ok" }, finish()]]);
    const hooked: unknown[] = [];
    await agent
      .stream({ messages: [], turn: { text: "write" }, onProviderRetry: (info) => hooked.push(info) })
      .result();
    expect(hooked[0]).toMatchObject({ toolArgumentsTooLong: { tool: "write", toolCallId: "c1" } });
  });
});
