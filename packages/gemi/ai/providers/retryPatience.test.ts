import { describe, expect, test } from "vitest";

import type { ProviderEvent, ProviderRetryInfo } from "../AgentProvider";
import { responsesEndpoint, streamResponses, type ResponsesEndpoint } from "./call";
import { azureTarget, openAITarget } from "./endpoints";
import { requestWithRetry, type FetchLike } from "./http";

/**
 * #1258: a retry patience budget. After the quick retries (`maxRetries`), a
 * provider with `retry.patienceMs` keeps asking, with longer waits, until the
 * budget is spent: long enough to outlast a one-minute rate-limit window.
 */

const res = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

/** A clock that only moves when the code under test sleeps (or fetches). */
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
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

async function request(
  statuses: Array<number | Response>,
  options: { maxRetries?: number; retry?: { patienceMs: number; initialWaitMs?: number; maxWaitMs?: number } },
) {
  const time = clocked();
  const seen: Omit<ProviderRetryInfo, "phase">[] = [];
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    time.tick(10);
    const next = statuses[Math.min(calls++, statuses.length - 1)]!;
    return typeof next === "number" ? res(next) : next;
  };
  const outcome = await requestWithRetry(
    "https://api.example/responses",
    { method: "POST" },
    {
      maxRetries: options.maxRetries ?? 1,
      timeoutMs: 0,
      fetchImpl,
      sleep: time.sleep,
      random: () => 0,
      now: time.now,
      onRetry: (info) => seen.push(info),
      ...(options.retry ? { retry: options.retry } : {}),
    },
  ).then(
    (response) => ({ status: response.status }),
    (error: unknown) => ({ error }),
  );
  return { outcome, sleeps: time.sleeps, seen, calls: () => calls };
}

describe("requestWithRetry: patience", () => {
  test("after the quick retries it keeps waiting, doubling from initialWaitMs", async () => {
    const { outcome, sleeps, calls } = await request([429, 429, 429, 429, 200], {
      maxRetries: 1,
      retry: { patienceMs: 180_000, initialWaitMs: 4_000 },
    });
    expect(outcome).toEqual({ status: 200 });
    expect(calls()).toBe(5);
    // 250 is the quick retry; then 4s, 8s, 16s, halved by `random: () => 0`.
    expect(sleeps).toEqual([250, 2_000, 4_000, 8_000]);
  });

  test("each wait is capped at maxWaitMs, Retry-After included", async () => {
    const limited = () => res(429, "", { "retry-after": "90" });
    const { outcome, sleeps } = await request([limited(), limited(), res(200)], {
      maxRetries: 0,
      retry: { patienceMs: 180_000, maxWaitMs: 60_000 },
    });
    expect(outcome).toEqual({ status: 200 });
    expect(sleeps).toEqual([60_000, 60_000]);
  });

  test("gives up once the budget is spent, with the last error", async () => {
    const { outcome, sleeps } = await request([503], {
      maxRetries: 0,
      retry: { patienceMs: 10_000, initialWaitMs: 4_000 },
    });
    expect((outcome as { error: { status: number } }).error.status).toBe(503);
    // 2s and 4s fit; the next 8s wait is cut to what is left of the budget.
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(10_000);
    expect(sleeps.slice(0, 2)).toEqual([2_000, 4_000]);
  });

  test("the retry event says what is left of the budget", async () => {
    const { seen } = await request([429, 429, 200], {
      maxRetries: 1,
      retry: { patienceMs: 60_000, initialWaitMs: 4_000 },
    });
    expect(seen.map((info) => [info.attempt, info.delayMs, info.remainingMs])).toEqual([
      [1, 250, 60_000 - 10 - 250],
      [2, 2_000, 60_000 - 20 - 250 - 2_000],
    ]);
  });

  test("a failure that is not retryable is not waited out", async () => {
    const quota = res(429, JSON.stringify({ error: { code: "insufficient_quota", message: "quota" } }));
    const { outcome, calls } = await request([quota, 200], {
      maxRetries: 0,
      retry: { patienceMs: 60_000 },
    });
    expect("error" in outcome).toBe(true);
    expect(calls()).toBe(1);
  });

  test("without a policy nothing changes: it stops after maxRetries", async () => {
    const { outcome, calls, seen } = await request([429], { maxRetries: 1 });
    expect("error" in outcome).toBe(true);
    expect(calls()).toBe(2);
    expect(seen[0]!.remainingMs).toBeUndefined();
  });

  test("an abort during a patient wait ends it at once", async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = async () => res(429);
    const pending = requestWithRetry(
      "https://api.example/responses",
      { method: "POST" },
      {
        maxRetries: 0,
        timeoutMs: 0,
        signal: controller.signal,
        fetchImpl,
        sleep: () => new Promise<void>(() => {}),
        onRetry: () => controller.abort(),
        retry: { patienceMs: 60_000 },
      },
    );
    await expect(pending).rejects.toBeDefined();
  });
});

describe("streamResponses: patience", () => {
  const frame = (payload: Record<string, unknown>) =>
    `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
  const OK = () =>
    new Response(
      frame({ type: "response.output_text.delta", delta: "ok" }) +
        frame({
          type: "response.completed",
          response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  /** Starts, then the socket drops before any content. */
  const DROPPED = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new TypeError("The socket connection was closed unexpectedly."));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  function endpoint(script: Array<() => Response>, retry?: ResponsesEndpoint["retry"]) {
    const time = clocked();
    let calls = 0;
    const value: ResponsesEndpoint = {
      ...responsesEndpoint({
        base: "https://api.example/v1",
        query: "",
        headers: async () => ({}),
        timeoutMs: 0,
        maxRetries: 0,
        ...(retry ? { retry } : {}),
      } as never),
      fetchImpl: async () => script[Math.min(calls++, script.length - 1)]!(),
      sleep: time.sleep,
      random: () => 0,
      now: time.now,
    };
    return { value, sleeps: time.sleeps, calls: () => calls };
  }

  async function collect(endpoint: ResponsesEndpoint) {
    const events: ProviderEvent[] = [];
    for await (const event of streamResponses(endpoint, { model: "m", input: [] } as never, {
      structuredOutput: false,
    })) {
      events.push(event);
    }
    return events;
  }

  test("a stream that keeps dropping before its first event is asked again within the budget", async () => {
    const e = endpoint([DROPPED, DROPPED, DROPPED, OK], { patienceMs: 60_000, initialWaitMs: 4_000 });
    const events = await collect(e.value);
    expect(e.calls()).toBe(4);
    expect(e.sleeps).toEqual([2_000, 4_000, 8_000]);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    expect(events.find((event) => event.type === "retry")).toMatchObject({
      phase: "stream",
      remainingMs: expect.any(Number),
    });
  });

  test("request-phase 429s go through the same budget", async () => {
    const e = endpoint([() => res(429), () => res(429), OK], { patienceMs: 60_000, initialWaitMs: 4_000 });
    const events = await collect(e.value);
    expect(e.calls()).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });
});

describe("config", () => {
  test("ProviderConfig.retry reaches the endpoint", () => {
    const retry = { patienceMs: 180_000, initialWaitMs: 4_000, maxWaitMs: 60_000 };
    expect(responsesEndpoint(openAITarget({ retry })).retry).toEqual(retry);
    expect(responsesEndpoint(azureTarget({ retry, endpoint: "https://x.openai.azure.com" })).retry).toEqual(
      retry,
    );
    expect(responsesEndpoint(openAITarget({})).retry).toBeUndefined();
  });

  test("refuses a policy it cannot use", () => {
    for (const retry of [{ patienceMs: -1 }, { patienceMs: 1_000, initialWaitMs: 0 }, { patienceMs: Number.NaN }]) {
      expect(() => openAITarget({ retry } as never)).toThrow(/retry/);
    }
  });
});

describe("Agent: the retry frame", () => {
  test("carries remainingMs to the client and the hook", async () => {
    const { Agent } = await import("../Agent");
    const { fakeProvider } = await import("./fakeProvider");
    const retry: ProviderEvent = {
      type: "retry",
      attempt: 3,
      maxRetries: 2,
      error: { code: "rate_limited", message: "slow down", retryable: true },
      phase: "request",
      timedOut: false,
      delayMs: 8_000,
      elapsedMs: 12_000,
      remainingMs: 160_000,
    };
    const hooked: unknown[] = [];
    const stream = Agent.create({
      name: "patient",
      provider: fakeProvider([
        retry,
        { type: "text-delta", delta: "ok" },
        { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]),
    }).stream({ messages: [], turn: { text: "hi" }, onProviderRetry: (info) => hooked.push(info) });
    const frames: unknown[] = [];
    for await (const event of stream) frames.push(event);
    expect(frames.find((frame: any) => frame.type === "retry")).toMatchObject({
      attempt: 3,
      delayMs: 8_000,
      remainingMs: 160_000,
    });
    expect(hooked[0]).toMatchObject({ remainingMs: 160_000 });
  });
});
