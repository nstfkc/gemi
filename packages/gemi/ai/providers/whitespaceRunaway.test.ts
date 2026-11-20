import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Agent, AgentTool } from "../Agent";
import {
  AnthropicProvider,
  AzureAnthropicProvider,
  AzureOpenAIProvider,
  OpenAIProvider,
  type AgentProvider,
  type ProviderEvent,
  type ProviderStreamParams,
} from "../AgentProvider";
import { s } from "../Schema";
import type { AgentMessage } from "../types";
import type { FetchLike } from "./http";

/**
 * #1334: a tool call whose arguments run away in white space (the model wrote
 * them, then kept streaming line breaks and spaces, an event every fraction of
 * a second) ends as soon as the run passes `maxToolArgumentWhitespace`,
 * instead of streaming until `streamMaxDurationMs`.
 */

const LIMIT = 1_000;

const frame = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

// What the runaway streams after the arguments: white space, forever.
const SPACE = "\n  \t \n    ".repeat(5); // 50 characters a delta

// --- Responses (OpenAI, Azure OpenAI) ---------------------------------------

const responses = {
  start: (name: string) =>
    frame({ type: "response.created", response: { model: "gpt-x" } }) +
    frame({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name },
    }),
  args: (delta: string) => frame({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta }),
  end: (name: string, args: string) =>
    frame({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: args }) +
    frame({
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: args },
    }) +
    frame({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 7 } } }),
  reply:
    frame({ type: "response.created", response: { model: "gpt-x" } }) +
    frame({ type: "response.output_text.delta", delta: "Done." }) +
    frame({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
};

// --- Messages (Anthropic, Azure Anthropic) ----------------------------------

const messages = {
  start: (name: string) =>
    frame({
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-x", usage: { input_tokens: 10, output_tokens: 1 } },
    }) + frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name, input: {} } }),
  args: (partial_json: string) =>
    frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } }),
  end: () =>
    frame({ type: "content_block_stop", index: 0 }) +
    frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }) +
    frame({ type: "message_stop" }),
  reply:
    frame({
      type: "message_start",
      message: { id: "msg_2", type: "message", role: "assistant", content: [], model: "claude-x", usage: { input_tokens: 1, output_tokens: 1 } },
    }) +
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }) +
    frame({ type: "content_block_stop", index: 0 }) +
    frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
    frame({ type: "message_stop" }),
};

// --- the stubbed fetch ------------------------------------------------------

/** A body that sends `head`, then `tail` again and again and never ends, the
 *  way the runaway did; `cancelled()` says whether the reader let go of it. */
function endless(head: string, tail: string) {
  let sent = 0;
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(sent++ === 0 ? head : tail));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled, chunks: () => sent };
}

type Answer = string | (() => ReadableStream<Uint8Array>);

/** Answers request `i` with `answers[i]` (the last repeats). */
function fakeFetch(answers: Answer[]) {
  let count = 0;
  const fetchImpl: FetchLike = async () => {
    const answer = answers[Math.min(count++, answers.length - 1)]!;
    const body = typeof answer === "string" ? answer : answer();
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetchImpl, requests: () => count };
}

function withFetch<P extends AgentProvider>(provider: P, fetchImpl: FetchLike): P {
  const endpoint = (provider as any).endpoint.bind(provider);
  (provider as any).endpoint = () => ({ ...endpoint(), fetchImpl, sleep: async () => {} });
  return provider;
}

type Wire = typeof responses | typeof messages;
type Vendor = { name: string; wire: Wire; make: (fetchImpl: FetchLike, config?: Record<string, unknown>) => AgentProvider };

const base = { apiKey: "k", maxRetries: 0 };
const vendors: Vendor[] = [
  { name: "OpenAIProvider", wire: responses, make: (f, c) => withFetch(new OpenAIProvider("gpt-5", { ...base, ...c }), f) },
  {
    name: "AzureOpenAIProvider",
    wire: responses,
    make: (f, c) => withFetch(new AzureOpenAIProvider("gpt-5", { ...base, endpoint: "https://r.openai.azure.com", ...c }), f),
  },
  { name: "AnthropicProvider", wire: messages, make: (f, c) => withFetch(new AnthropicProvider("claude-opus-5-5", { ...base, ...c }), f) },
  {
    name: "AzureAnthropicProvider",
    wire: messages,
    make: (f, c) =>
      withFetch(
        new AzureAnthropicProvider("claude-opus-5-5", { ...base, endpoint: "https://r.services.ai.azure.com/anthropic", ...c }),
        f,
      ),
  },
];

async function drain(provider: AgentProvider) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ messages: [] } as unknown as ProviderStreamParams)) {
    events.push(event);
  }
  return events;
}

const errorOf = (events: ProviderEvent[]) =>
  events.find((e) => e.type === "error") as Extract<ProviderEvent, { type: "error" }> | undefined;

const results = (list: AgentMessage[]) =>
  list.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

const WHOLE = '{"q":"a"}';
const HALF = '{"body":"abc",';

const ran: string[] = [];
const tools = [
  AgentTool.create({
    name: "lookup",
    description: "Look up",
    inputSchema: s.object({ q: s.string() }),
    execute: async ({ q }) => {
      ran.push(q);
      return { found: q };
    },
  }),
  AgentTool.create({
    name: "write",
    description: "Write a page",
    inputSchema: s.object({ body: s.string(), title: s.string() }),
    execute: async ({ body }) => ({ wrote: body.length }),
  }),
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

for (const vendor of vendors) {
  const { wire } = vendor;
  // The arguments, then white space as separate deltas, forever.
  const runaway = (name: string, args: string) => () => endless(wire.start(name) + wire.args(args), wire.args(SPACE)).body;

  describe(`${vendor.name}: a call that runs away in white space (#1334)`, () => {
    test("whole JSON: the call is finished as written and the stream ends at once", async () => {
      const stream = endless(wire.start("lookup") + wire.args(WHOLE), wire.args(SPACE));
      const { fetchImpl, requests } = fakeFetch([() => stream.body]);
      const events = await drain(vendor.make(fetchImpl));

      expect(errorOf(events)).toBeUndefined();
      expect(events.filter((e) => e.type === "tool-call")).toEqual([
        { type: "tool-call", toolCallId: "call_1", name: "lookup", args: WHOLE },
      ]);
      const finish = events.at(-1);
      expect(finish).toMatchObject({ type: "finish", reason: "stop" });
      // Anthropic reports usage on `message_start`; the Responses API only on
      // its terminal frame, which never came.
      if (wire === messages) expect((finish as any).usage).toMatchObject({ inputTokens: 10, outputTokens: 1 });
      else expect((finish as any).usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
      expect(requests()).toBe(1);
      // About 1,000 characters of white space were read, not 150,000.
      expect(stream.chunks()).toBeLessThan(LIMIT / SPACE.length + 5);
      expect(stream.cancelled()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({ tool: "lookup", toolCallId: "call_1", limit: LIMIT, whole: true });
    });

    test("whole JSON: the agent runs the call and goes on", async () => {
      ran.length = 0;
      const { fetchImpl, requests } = fakeFetch([runaway("lookup", WHOLE), wire.reply]);
      const agent = Agent.create({ name: "finder", provider: vendor.make(fetchImpl), tools });

      const result = await agent.stream({ messages: [], turn: { text: "find a" } }).result();

      expect(result.error).toBeUndefined();
      expect(ran).toEqual(["a"]);
      expect(requests()).toBe(2);
      expect(results(result.messages)).toEqual([expect.objectContaining({ toolCallId: "call_1", status: "ok" })]);
    });

    test("half-written JSON: cut like a call past the length limit, naming the white space", async () => {
      const { fetchImpl, requests } = fakeFetch([runaway("write", HALF)]);
      const events = await drain(vendor.make(fetchImpl));

      const error = errorOf(events);
      expect(error?.error).toMatchObject({ code: "provider_error", retryable: true });
      expect(error?.error.message).toContain("maxToolArgumentWhitespace");
      expect(error?.toolArgumentsTooLong).toMatchObject({ tool: "write", toolCallId: "call_1", limit: LIMIT });
      expect(error?.toolArgumentsTooLong?.whitespace).toBeGreaterThan(LIMIT);
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
      expect(requests()).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({ tool: "write", whole: false });
    });

    test("half-written JSON: asked again under the provider's retries", async () => {
      const { fetchImpl, requests } = fakeFetch([runaway("write", HALF), wire.reply]);
      const events = await drain(vendor.make(fetchImpl, { maxRetries: 1 }));

      expect(requests()).toBe(2);
      expect(events).toContainEqual({ type: "tool-call-discard", toolCallIds: ["call_1"] });
      expect(events.find((e) => e.type === "retry")).toMatchObject({
        phase: "stream",
        toolArgumentsTooLong: expect.objectContaining({ toolCallId: "call_1" }),
      });
      expect(errorOf(events)).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    });

    test("half-written JSON: the agent answers the call with the tool's error", async () => {
      const { fetchImpl, requests } = fakeFetch([runaway("write", HALF), wire.reply]);
      const agent = Agent.create({
        name: "writer",
        provider: vendor.make(fetchImpl, { maxRetries: 2 }),
        tools,
        onToolArgumentsTooLong: { toolError: 1 },
      });

      const result = await agent.stream({ messages: [], turn: { text: "write" } }).result();

      expect(result.error).toBeUndefined();
      expect(requests()).toBe(2);
      expect(results(result.messages)).toEqual([
        expect.objectContaining({
          toolCallId: "call_1",
          status: "error",
          error: expect.objectContaining({ code: "invalid_tool_input", message: expect.stringContaining("white space") }),
        }),
      ]);
    });

    test("long arguments with white space inside strings and between tokens are not cut", async () => {
      // 5,000 characters of white space inside a string, then pretty-printed
      // JSON whose runs between tokens stay under the limit.
      const body = `line one\n${" ".repeat(2_500)}\n\t${"\n".repeat(2_500)}end \\" still inside`;
      const args = `{\n${" ".repeat(400)}"body": ${JSON.stringify(body)},\n${" ".repeat(900)}"title": "t"\n}`;
      const chunks = args.match(/[\s\S]{1,37}/g)!;
      const raw = wire.start("write") + chunks.map((c) => wire.args(c)).join("") + (wire === messages ? messages.end() : responses.end("write", args));
      const { fetchImpl } = fakeFetch([raw]);
      const events = await drain(vendor.make(fetchImpl));

      expect(errorOf(events)).toBeUndefined();
      expect(events.filter((e) => e.type === "tool-call")).toEqual([
        { type: "tool-call", toolCallId: "call_1", name: "write", args },
      ]);
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
      expect(warn).not.toHaveBeenCalled();
    });
  });
}

test("maxToolArgumentWhitespace: 0 turns it off", async () => {
  const head = responses.start("lookup") + responses.args(WHOLE) + responses.args(" ".repeat(3_000));
  const { fetchImpl } = fakeFetch([head + responses.end("lookup", WHOLE + " ".repeat(3_000))]);
  const events = await drain(vendors[0]!.make(fetchImpl, { maxToolArgumentWhitespace: 0 }));

  expect(events.filter((e) => e.type === "tool-call")).toEqual([
    { type: "tool-call", toolCallId: "call_1", name: "lookup", args: WHOLE + " ".repeat(3_000) },
  ]);
});
