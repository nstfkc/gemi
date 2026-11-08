process.env.SECRET ??= "provider-retry-test-secret";

import { describe, expect, test } from "vitest";

import { Agent, AgentTool, type AgentProviderRetry } from "./Agent";
import type { ProviderEvent, ProviderRetryInfo } from "./AgentProvider";
import { applyFrame, initialChatState } from "./client/reducer";
import { FallbackProvider } from "./FallbackProvider";
import { generate } from "./generate";
import { responsesEndpoint, streamResponses, type ResponsesEndpoint } from "./providers/call";
import { fakeProvider } from "./providers/fakeProvider";
import { requestWithRetry, type FetchLike } from "./providers/http";
import { s } from "./Schema";
import type { AgentError, AgentStreamEvent } from "./types";

/**
 * #1192: a provider's retries are visible outside it, as `retry` events on
 * the provider stream, an `onProviderRetry` hook on the run, and a `retry`
 * frame for the client.
 */

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const rateLimited: AgentError = { code: "rate_limited", message: "slow down", retryable: true };

const retry = (fields: Partial<ProviderRetryInfo> = {}): ProviderEvent => ({
  type: "retry",
  attempt: 1,
  maxRetries: 2,
  error: rateLimited,
  status: 429,
  requestId: "req_1",
  phase: "request",
  timedOut: false,
  delayMs: 250,
  elapsedMs: 40,
  ...fields,
});

const res = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe("requestWithRetry: onRetry", () => {
  test("one call per retried attempt, before its wait, with status, request id and delay", async () => {
    let clock = 1000;
    const order: string[] = [];
    const seen: unknown[] = [];
    const responses = [
      res(503, "", { "x-request-id": "req_a" }),
      res(429, "", { "retry-after": "2", "x-request-id": "req_b" }),
      res(200, "ok"),
    ];
    let i = 0;
    const response = await requestWithRetry(
      "https://api.example/responses",
      { method: "POST" },
      {
        maxRetries: 2,
        timeoutMs: 0,
        fetchImpl: async () => {
          clock += 10;
          return responses[i++]!;
        },
        sleep: async (ms) => {
          order.push(`sleep ${ms}`);
        },
        random: () => 0,
        now: () => clock,
        onRetry: (info) => {
          order.push(`retry ${info.attempt}`);
          seen.push(info);
        },
      },
    );
    expect(await response.text()).toBe("ok");
    expect(order).toEqual(["retry 1", "sleep 250", "retry 2", "sleep 2000"]);
    expect(seen).toEqual([
      {
        attempt: 1,
        maxRetries: 2,
        error: expect.objectContaining({ retryable: true }),
        status: 503,
        requestId: "req_a",
        timedOut: false,
        delayMs: 250,
        elapsedMs: 10,
      },
      expect.objectContaining({ attempt: 2, status: 429, requestId: "req_b", delayMs: 2000, elapsedMs: 20 }),
    ]);
  });

  test("not called for the last attempt, and a hook that throws changes nothing", async () => {
    const calls: number[] = [];
    const fetchImpl: FetchLike = async () => res(503);
    await expect(
      requestWithRetry(
        "https://api.example/responses",
        { method: "POST" },
        {
          maxRetries: 1,
          timeoutMs: 0,
          fetchImpl,
          sleep: async () => {},
          onRetry: (info) => {
            calls.push(info.attempt);
            throw new Error("hook bug");
          },
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([1]);
  });
});

describe("streamResponses: request retries", () => {
  const OK = () =>
    new Response(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  function endpoint(fetchImpl: FetchLike, sleep: ResponsesEndpoint["sleep"]): ResponsesEndpoint {
    return {
      ...responsesEndpoint({
        base: "https://api.example/v1",
        query: "",
        headers: async () => ({}),
        timeoutMs: 0,
        maxRetries: 2,
      } as never),
      fetchImpl,
      sleep,
      random: () => 0,
    };
  }

  test("a retry event is yielded while the backoff is still running", async () => {
    let calls = 0;
    let release!: () => void;
    const fetchImpl: FetchLike = async () => (calls++ === 0 ? res(503, "", { "x-request-id": "req_x" }) : OK());
    const sleep = () => new Promise<void>((resolve) => (release = resolve));
    const iterator = streamResponses(endpoint(fetchImpl, sleep), { model: "m", input: [] } as never, {
      structuredOutput: false,
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({
      type: "retry",
      attempt: 1,
      maxRetries: 2,
      error: expect.objectContaining({ retryable: true }),
      status: 503,
      requestId: "req_x",
      phase: "request",
      timedOut: false,
      delayMs: 250,
      elapsedMs: expect.any(Number),
    });
    // The second request has not been sent: the provider is still waiting.
    expect(calls).toBe(1);
    release();
    const rest: ProviderEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    expect(calls).toBe(2);
    expect(rest.map((event) => event.type)).toEqual(["text-delta", "finish"]);
  });
});

describe("FallbackProvider", () => {
  test("passes a leg's retry on as it happens, before the leg commits", async () => {
    const primary = fakeProvider([retry(), { type: "text-delta", delta: "hi" }, finish()]);
    const chain = FallbackProvider.chain([{ provider: primary }]);
    const events: ProviderEvent[] = [];
    for await (const event of chain.stream({ messages: [] } as never)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["retry", "text-delta", "finish"]);
  });
});

describe("Agent: onProviderRetry and the retry frame", () => {
  async function frames(run: { frames(from?: number): AsyncIterable<{ event: AgentStreamEvent }> }) {
    const out: AgentStreamEvent[] = [];
    for await (const frame of run.frames()) out.push(frame.event);
    return out;
  }

  test("the hook gets the full detail with the run's context; the client gets the code", async () => {
    const provider = fakeProvider([retry(), { type: "text-delta", delta: "hi" }, finish()]);
    const agent = Agent.create({ name: "writer", provider });
    const seen: AgentProviderRetry[] = [];
    const run = agent.stream({
      messages: [],
      turn: { text: "go" },
      onProviderRetry: (info) => {
        seen.push(info);
      },
    });
    const wire = frames(run);
    await run.result();
    const events = await wire;

    expect(seen).toEqual([
      {
        attempt: 1,
        maxRetries: 2,
        error: rateLimited,
        status: 429,
        requestId: "req_1",
        phase: "request",
        timedOut: false,
        delayMs: 250,
        elapsedMs: 40,
        runId: run.runId,
        agent: "writer",
        step: 1,
      },
    ]);
    const frame = events.find((event) => event.type === "retry");
    expect(frame).toEqual({
      type: "retry",
      messageId: expect.any(String),
      attempt: 1,
      maxRetries: 2,
      code: "rate_limited",
      delayMs: 250,
    });
    expect(JSON.stringify(frame)).not.toMatch(/slow down|req_1|429/);
  });

  test("a hook that throws or rejects does not fail the run", async () => {
    for (const hook of [
      () => {
        throw new Error("boom");
      },
      () => Promise.reject(new Error("boom")),
    ]) {
      const provider = fakeProvider([retry(), { type: "text-delta", delta: "hi" }, finish()]);
      const agent = Agent.create({ name: "writer", provider });
      const result = await agent
        .stream({ messages: [], turn: { text: "go" }, onProviderRetry: hook })
        .result();
      expect(result.finishReason).toBe("stop");
    }
  });

  test("a sub-run's retries reach the same hook with the sub-run's own context", async () => {
    const subProvider = fakeProvider([retry({ attempt: 1 }), { type: "text-delta", delta: "x" }, finish()]);
    const sub = Agent.create({ name: "researcher", provider: subProvider });
    const research = AgentTool.create({
      name: "research",
      description: "Delegate",
      inputSchema: s.object({}),
      execute: async (_input: unknown, ctx: any) => {
        await ctx.runAgent(sub, { prompt: "go" });
        return {};
      },
    });
    const provider = fakeProvider(
      [{ type: "tool-call", toolCallId: "c1", name: "research", args: "{}" }, finish()],
      [{ type: "text-delta", delta: "done" }, finish()],
    );
    const agent = Agent.create({ name: "lead", provider, tools: [research] });
    const seen: AgentProviderRetry[] = [];
    const run = agent.stream({
      messages: [],
      turn: { text: "go" },
      onProviderRetry: (info) => {
        seen.push(info);
      },
    });
    const wire = frames(run);
    await run.result();
    const events = await wire;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent: "researcher", step: 1 });
    expect(seen[0]!.runId).not.toBe(run.runId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "nested-event",
        event: expect.objectContaining({ type: "retry", attempt: 1 }),
      }),
    );
  });
});

describe("the client reducer", () => {
  test("a retry frame leaves the transcript as it is", () => {
    const state = initialChatState();
    const next = applyFrame(
      state,
      {
        seq: 1,
        event: { type: "retry", messageId: "m1", attempt: 1, maxRetries: 2, code: "rate_limited", delayMs: 250 },
      },
      "2026-11-09T00:00:00.000Z",
    );
    expect(next.messages).toEqual(state.messages);
    expect(next.error).toBeNull();
  });
});

describe("generate: onProviderRetry", () => {
  test("hears the provider's retries", async () => {
    const provider = fakeProvider([
      retry(),
      { type: "output-delta", delta: '{"headline":"a"}' },
      finish(),
    ]);
    const seen: ProviderRetryInfo[] = [];
    const result = await generate({
      provider,
      prompt: "go",
      output: s.object({ headline: s.string() }),
      onProviderRetry: (info) => {
        seen.push(info);
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ attempt: 1, status: 429, phase: "request" })]);
  });
});
