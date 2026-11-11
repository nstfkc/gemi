import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type {
  AgentProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderStreamParams,
  ProviderToolSpec,
} from "../AgentProvider";
import { AnthropicProvider } from "../AgentProvider";
import { FallbackProvider } from "../FallbackProvider";
import { RecordingProvider, type Recording } from "../testing/RecordingProvider";
import type { AgentMessage } from "../types";
import { buildMessagesRequest, DEFAULT_MAX_TOKENS, toMessages } from "./anthropicRequest";
import { parseMessagesStream, toAnthropicUsage } from "./anthropicStream";
import { capabilitiesForClaude, supportsForcedToolChoice } from "./capabilities";
import { ANTHROPIC_VERSION } from "./endpoints";
import { normalizeProviderError, ProviderHttpError } from "./errors";
import { fakeProvider } from "./fakeProvider";
import type { FetchLike } from "./http";

/**
 * The Anthropic provider, offline. The `__fixtures__/anthropic-*` files are
 * HAND-WRITTEN from the event and error shapes in Anthropic's streaming and
 * errors references (no live call was made to write them), so unlike the
 * `openai-*` recordings they test the documented shape, not captured traffic.
 * `live/` has an opt-in test that checks the real thing.
 */

const DIR = join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => readFileSync(join(DIR, name), "utf8");

async function parse(raw: string | string[], options?: { structuredOutput?: boolean }) {
  const out: ProviderEvent[] = [];
  const chunks = typeof raw === "string" ? [raw] : raw;
  for await (const event of parseMessagesStream(chunks, options)) out.push(event);
  return out;
}

const CLAUDE = capabilitiesForClaude("claude-opus-5-5");

function message(partial: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">) {
  return { id: "m1", createdAt: "2026-01-01T00:00:00.000Z", ...partial } as AgentMessage;
}

function tool(name: string): ProviderToolSpec {
  return {
    name,
    description: `does ${name}`,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  } as ProviderToolSpec;
}

function build(
  params: Partial<ProviderStreamParams>,
  ctx: { model?: string; capabilities?: ProviderCapabilities } = {},
) {
  const model = ctx.model ?? "claude-opus-5-5";
  return buildMessagesRequest({ messages: [], ...params } as ProviderStreamParams, {
    model,
    capabilities: ctx.capabilities ?? capabilitiesForClaude(model),
    forcedToolChoice: supportsForcedToolChoice(model),
  });
}

describe("parseMessagesStream()", () => {
  test("text, with the model and usage from the stream", async () => {
    const events = await parse(fixture("anthropic-text.sse"));
    expect(events).toEqual([
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: "! How can I help?" },
      {
        type: "finish",
        reason: "stop",
        model: "claude-opus-5-5",
        // `output_tokens` is the cumulative one from `message_delta`.
        usage: {
          inputTokens: 25,
          outputTokens: 15,
          totalTokens: 40,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      },
    ]);
  });

  test("the same stream fed a byte at a time parses the same", async () => {
    const raw = fixture("anthropic-parallel-tools.sse");
    expect(await parse(raw.split(""))).toEqual(await parse(raw));
  });

  test("parallel tool calls stay apart, each with its own id and arguments", async () => {
    const events = await parse(fixture("anthropic-parallel-tools.sse"));
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toEqual([
      { type: "tool-call", toolCallId: "toolu_01ParisFixture0000000001", name: "getWeather", args: '{"city": "Paris"}' },
      { type: "tool-call", toolCallId: "toolu_01TokyoFixture0000000001", name: "getWeather", args: '{"city": "Tokyo"}' },
      // No argument deltas at all: the input is the empty object.
      { type: "tool-call", toolCallId: "toolu_01ClockFixture0000000001", name: "currentTime", args: "{}" },
    ]);
    const deltas = events.filter((e) => e.type === "tool-call-delta");
    // The empty first `partial_json` is not passed on.
    expect(deltas.map((e) => (e as { argsDelta: string }).argsDelta)).toEqual([
      '{"city":',
      ' "Paris"}',
      '{"city": "Tokyo"}',
    ]);
    expect(events[0]).toEqual({ type: "text-delta", delta: "Checking both cities." });
  });

  test("usage counts the cache reads and writes into the input, and breaks them out", async () => {
    const events = await parse(fixture("anthropic-parallel-tools.sse"));
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "stop",
      model: "claude-sonnet-5-5",
      usage: {
        inputTokens: 12 + 340 + 2048,
        outputTokens: 89,
        totalTokens: 12 + 340 + 2048 + 89,
        cachedInputTokens: 2048,
        cacheWriteInputTokens: 340,
      },
    });
  });

  test("a usage with no cache fields has no cache breakdown", () => {
    expect(toAnthropicUsage({ input_tokens: 10, output_tokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  });

  test("max_tokens ends `length`", async () => {
    const events = await parse(fixture("anthropic-max-tokens.sse"));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "length" });
  });

  test("a refusal is `content_filtered`, not an answer", async () => {
    const events = await parse(fixture("anthropic-refusal.sse"));
    expect(events).toEqual([
      {
        type: "error",
        error: {
          code: "content_filtered",
          message: "The model declined to answer (cyber).",
          retryable: false,
        },
      },
      expect.objectContaining({ type: "finish", reason: "error" }),
    ]);
  });

  test("an overloaded_error frame is a retryable error", async () => {
    const events = await parse(fixture("anthropic-error-overloaded.sse"));
    expect(events).toEqual([
      { type: "error", error: { code: "provider_error", message: "Overloaded", retryable: true } },
      expect.objectContaining({ type: "finish", reason: "error", model: "claude-opus-5-5" }),
    ]);
  });

  test("a stream that ends without message_stop is a retryable error", async () => {
    const raw = fixture("anthropic-text.sse");
    const cut = raw.slice(0, raw.indexOf("event: message_delta"));
    const events = await parse(cut);
    expect(events.at(-2)).toEqual({
      type: "error",
      error: {
        code: "provider_error",
        message: "The provider stream ended without a terminal event.",
        retryable: true,
      },
    });
  });

  test("with an output schema, text is the answer's JSON", async () => {
    const events = await parse(fixture("anthropic-text.sse"), { structuredOutput: true });
    expect(events[0]).toEqual({ type: "output-delta", delta: "Hello" });
  });

  test("unknown event types are ignored", async () => {
    const raw = fixture("anthropic-text.sse").replace(
      "event: ping",
      'event: something_new\ndata: {"type":"something_new"}\n\nevent: ping',
    );
    expect(await parse(raw)).toEqual(await parse(fixture("anthropic-text.sse")));
  });
});

describe("HTTP errors", () => {
  const error = (status: number, file: string, retryAfter?: number) =>
    normalizeProviderError(
      new ProviderHttpError(status, JSON.parse(fixture(file)), "req_x", retryAfter),
    );

  test("529 overloaded is retryable", () => {
    expect(error(529, "anthropic-error-overloaded.json")).toEqual({
      code: "provider_error",
      message: "Overloaded",
      retryable: true,
    });
  });

  test("429 is rate_limited, with the retry-after the header gave", () => {
    expect(error(429, "anthropic-error-rate-limit.json", 12_000)).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfter: 12_000,
    });
  });

  test("a prompt over the context window is context_length_exceeded", () => {
    expect(error(400, "anthropic-error-prompt-too-long.json")).toEqual({
      code: "context_length_exceeded",
      message: "prompt is too long: 1043211 tokens > 1000000 maximum",
      retryable: false,
    });
  });

  test("an invalid request is not retried", () => {
    expect(error(400, "anthropic-error-invalid-request.json")).toMatchObject({
      code: "provider_error",
      retryable: false,
    });
  });
});

describe("buildMessagesRequest()", () => {
  test("the basics: model, max_tokens, stream, system, and no temperature", () => {
    const body = build({
      systemPrompt: "Be brief.",
      temperature: 0.2,
      promptCacheKey: "agent:abc",
      messages: [message({ role: "user", content: [{ type: "text", text: "hi" }] })],
    });
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([{ type: "text", text: "Be brief." }]);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    // A 400 on API version 2026-10-21; the cache key has no counterpart.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  test("maxOutputTokens is max_tokens", () => {
    expect(build({ maxOutputTokens: 1024 }).max_tokens).toBe(1024);
  });

  test("tools are flat, without strict, with eager input streaming", () => {
    const body = build({
      tools: [
        tool("read"),
        { name: "crm", description: "orders", tools: [{ ...tool("getOrder"), deferred: true }] },
      ],
    });
    expect(body.tools).toEqual([
      {
        name: "read",
        description: "does read",
        input_schema: tool("read").parameters,
        eager_input_streaming: true,
      },
      {
        name: "getOrder",
        description: "does getOrder",
        input_schema: tool("getOrder").parameters,
        eager_input_streaming: true,
      },
    ]);
    expect(body).not.toHaveProperty("tool_choice");
  });

  test("tool_choice: auto and none as they are", () => {
    expect(build({ tools: [tool("a")], toolChoice: "auto" }).tool_choice).toEqual({ type: "auto" });
    expect(build({ tools: [tool("a")], toolChoice: "none" }).tool_choice).toEqual({ type: "none" });
  });

  test("tool_choice: required and a named tool, on a model that takes them", () => {
    const opts = { model: "claude-opus-5" };
    expect(build({ tools: [tool("a")], toolChoice: "required" }, opts).tool_choice).toEqual({
      type: "any",
    });
    expect(build({ tools: [tool("a")], toolChoice: { name: "a" } }, opts).tool_choice).toEqual({
      type: "tool",
      name: "a",
    });
    expect(
      build({ tools: [tool("a")], toolChoice: "required" }, { model: "claude-haiku-5-5" }).tool_choice,
    ).toEqual({ type: "any" });
  });

  test("tool_choice: forced choices are sent auto on models that refuse them", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-next-9"]) {
      expect(build({ tools: [tool("a")], toolChoice: "required" }, { model }).tool_choice).toEqual({
        type: "auto",
      });
      expect(build({ tools: [tool("a")], toolChoice: { name: "a" } }, { model }).tool_choice).toEqual(
        { type: "auto" },
      );
    }
  });

  test("no tools, no tool_choice", () => {
    expect(build({ toolChoice: "required" })).not.toHaveProperty("tool_choice");
  });
});

describe("toMessages()", () => {
  test("a step's calls stay in the assistant turn and their results open the next user turn", () => {
    const out = toMessages(
      [
        message({ role: "user", content: [{ type: "text", text: "weather?" }] }),
        message({
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool-call", toolCallId: "t1", name: "w", input: { city: "Paris" } },
            { type: "tool-call", toolCallId: "t2", name: "w", input: { city: "Tokyo" } },
            { type: "tool-result", toolCallId: "t2", name: "w", status: "ok", output: { c: 20 } },
            { type: "tool-result", toolCallId: "t1", name: "w", status: "ok", output: "sunny" },
          ],
        }),
        message({ role: "assistant", content: [{ type: "text", text: "Both fine." }] }),
        message({ role: "user", content: [{ type: "text", text: "thanks" }] }),
      ],
      CLAUDE,
    );
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t1", name: "w", input: { city: "Paris" } },
          { type: "tool_use", id: "t2", name: "w", input: { city: "Tokyo" } },
        ],
      },
      {
        role: "user",
        // In call order, whatever order the results were written in.
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "sunny" },
          { type: "tool_result", tool_use_id: "t2", content: '{"c":20}' },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Both fine." }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ]);
  });

  test("the next step in the same message comes after the results, calls included", () => {
    const out = toMessages(
      [
        message({
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "t1", name: "w", input: {} },
            { type: "tool-result", toolCallId: "t1", name: "w", status: "ok", output: "a" },
            { type: "tool-call", toolCallId: "t2", name: "w", input: {} },
            { type: "tool-result", toolCallId: "t2", name: "w", status: "ok", output: "b" },
            { type: "text", text: "done" },
          ],
        }),
      ],
      CLAUDE,
    );
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "w", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "w", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  test("a failed tool is is_error; a denied one is told in words", () => {
    const out = toMessages(
      [
        message({
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "t1", name: "w", input: {} },
            { type: "tool-call", toolCallId: "t2", name: "w", input: {} },
            {
              type: "tool-result",
              toolCallId: "t1",
              name: "w",
              status: "error",
              error: { code: "tool_error", message: "boom", retryable: false },
            },
            { type: "tool-result", toolCallId: "t2", name: "w", status: "denied", cause: "refused" },
          ],
        }),
      ],
      CLAUDE,
    );
    expect(out[1]!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "The tool call failed and produced no result. Error (tool_error): boom",
        is_error: true,
      },
      {
        type: "tool_result",
        tool_use_id: "t2",
        content: "The user declined this tool call, so it did not run.",
      },
    ]);
  });

  test("a call with no result gets one; a result with no call, a repeat and a partial call are dropped", () => {
    const out = toMessages(
      [
        message({
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "t1", name: "w", input: {} },
            { type: "tool-call", toolCallId: "t1", name: "w", input: {} },
            { type: "tool-call", toolCallId: "t2", name: "w", input: {}, partial: true },
            { type: "tool-result", toolCallId: "t2", name: "w", status: "denied", cause: "stopped" },
            { type: "tool-result", toolCallId: "ghost", name: "w", status: "ok", output: 1 },
          ],
        }),
        message({ role: "user", content: [{ type: "text", text: "go on" }] }),
      ],
      CLAUDE,
    );
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "w", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "No result was recorded for this tool call. Assume it did not complete.",
          },
          { type: "text", text: "go on" },
        ],
      },
    ]);
  });

  test("another provider's reasoning is left out, and empty text is not sent", () => {
    const out = toMessages(
      [
        message({ role: "user", content: [{ type: "text", text: "hi" }] }),
        message({
          role: "assistant",
          content: [
            { type: "reasoning", id: "rs_1", text: "openai thoughts" },
            { type: "text", text: "  " },
            { type: "text", text: "hello" },
          ],
        }),
      ],
      CLAUDE,
    );
    expect(out[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });

  test("an output part is sent back as its JSON", () => {
    const out = toMessages(
      [message({ role: "assistant", content: [{ type: "output", value: { ok: true } }] })],
      CLAUDE,
    );
    expect(out).toEqual([{ role: "assistant", content: [{ type: "text", text: '{"ok":true}' }] }]);
  });
});

describe("capabilitiesForClaude()", () => {
  test("adaptive thinking from 4.6 on; budget-only models get no reasoning", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5-1", "claude-next-1"]) {
      expect(capabilitiesForClaude(id).reasoning).toBe(true);
    }
    for (const id of ["claude-haiku-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-1", "claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"]) {
      expect(capabilitiesForClaude(id).reasoning).toBe(false);
    }
  });

  test("forced tool choice: known families only", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-haiku-4-5"]) {
      expect(supportsForcedToolChoice(id)).toBe(true);
    }
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5-2", "claude-next-1"]) {
      expect(supportsForcedToolChoice(id)).toBe(false);
    }
  });
});

// --- the provider, end to end over a fake fetch ----------------------------

type Call = { url: string; headers: Record<string, string>; body: any };

class TestAnthropic extends AnthropicProvider {
  constructor(
    model: string,
    private readonly fetchImpl: FetchLike,
    config: ConstructorParameters<typeof AnthropicProvider>[1] = {},
  ) {
    super(model, { apiKey: "test-key", ...config });
  }

  protected override endpoint() {
    return { ...super.endpoint(), fetchImpl: this.fetchImpl, sleep: async () => {}, random: () => 0 };
  }
}

function server(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    return responses[Math.min(calls.length - 1, responses.length - 1)]!();
  };
  return { calls, fetchImpl };
}

const sse = (raw: string) => () =>
  new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (status: number, raw: string, headers: Record<string, string> = {}) => () =>
  new Response(raw, { status, headers: { "content-type": "application/json", ...headers } });

async function drain(provider: AgentProvider, params: Partial<ProviderStreamParams> = {}) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ messages: [], ...params } as ProviderStreamParams)) {
    events.push(event);
  }
  return events;
}

describe("AnthropicProvider", () => {
  test("posts to /v1/messages with the key and the API version", async () => {
    const { calls, fetchImpl } = server([sse(fixture("anthropic-text.sse"))]);
    const events = await drain(new TestAnthropic("claude-opus-5-5", fetchImpl));
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  test("a baseURL is the host, with or without /v1", async () => {
    for (const baseURL of ["https://gw.example", "https://gw.example/v1/"]) {
      const { calls, fetchImpl } = server([sse(fixture("anthropic-text.sse"))]);
      await drain(new TestAnthropic("claude-opus-5-5", fetchImpl, { baseURL }));
      expect(calls[0]!.url).toBe("https://gw.example/v1/messages");
    }
  });

  test("a 529 is asked again, then answers", async () => {
    const { calls, fetchImpl } = server([
      json(529, fixture("anthropic-error-overloaded.json"), { "request-id": "req_1" }),
      sse(fixture("anthropic-text.sse")),
    ]);
    const events = await drain(new TestAnthropic("claude-opus-5-5", fetchImpl));
    expect(calls).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "retry",
      phase: "request",
      status: 529,
      requestId: "req_1",
      error: { code: "provider_error", retryable: true },
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  test("an overloaded_error before any content is asked again", async () => {
    const { calls, fetchImpl } = server([
      sse(fixture("anthropic-error-overloaded.sse")),
      sse(fixture("anthropic-text.sse")),
    ]);
    const events = await drain(new TestAnthropic("claude-opus-5-5", fetchImpl));
    expect(calls).toHaveLength(2);
    expect(events.find((e) => e.type === "retry")).toMatchObject({ phase: "stream" });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    // The dropped attempt's usage is billed too, and lands on the finish.
    expect(events.at(-1)).toMatchObject({ type: "finish", usage: { inputTokens: 50 } });
  });

  test("a prompt that is too long fails once, not maxRetries times", async () => {
    const { calls, fetchImpl } = server([json(400, fixture("anthropic-error-prompt-too-long.json"))]);
    const events = await drain(new TestAnthropic("claude-opus-5-5", fetchImpl));
    expect(calls).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { code: "context_length_exceeded", retryable: false },
      status: 400,
    });
  });

  test("models() lists the current Claude ids", () => {
    expect(AnthropicProvider.models()).toContain("claude-opus-5-5");
    expect(AnthropicProvider.models()).toContain("claude-haiku-5-5");
  });
});

describe("with FallbackProvider and RecordingProvider", () => {
  test("a FallbackProvider leg: an overloaded Claude hands the call to the next leg", async () => {
    const { fetchImpl } = server([json(529, fixture("anthropic-error-overloaded.json"))]);
    const claude = new TestAnthropic("claude-opus-5-5", fetchImpl, { maxRetries: 0 });
    const backup = fakeProvider([
      { type: "text-delta", delta: "from backup" },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    const chain = FallbackProvider.chain([
      { provider: claude },
      { provider: backup as unknown as AgentProvider },
    ]);
    const events = await drain(chain);
    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", delta: "from backup" },
    ]);
  });

  test("a RecordingProvider records a Claude call and replays it without the network", async () => {
    const { calls, fetchImpl } = server([sse(fixture("anthropic-parallel-tools.sse"))]);
    const params = {
      systemPrompt: "Be brief.",
      tools: [tool("getWeather"), tool("currentTime")],
      messages: [message({ role: "user", content: [{ type: "text", text: "weather?" }] })],
    };
    const recorder = RecordingProvider.record(new TestAnthropic("claude-sonnet-5-5", fetchImpl));
    const live = await drain(recorder, params);
    const recording = JSON.parse(JSON.stringify(recorder.recording())) as Recording;

    const replay = RecordingProvider.replay(recording);
    const replayed = await drain(replay, params);
    expect(calls).toHaveLength(1);
    expect(replayed.filter((e) => e.type === "tool-call")).toEqual(
      live.filter((e) => e.type === "tool-call"),
    );
    expect(replay.replayedInFull()).toBe(true);
  });
});
