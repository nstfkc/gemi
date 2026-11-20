import { describe, expect, test } from "vitest";

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
import { FallbackProvider } from "../FallbackProvider";
import { s } from "../Schema";
import type { AgentMessage } from "../types";
import type { FetchLike } from "./http";

/**
 * #1326: a tool call cut at `maxToolArgumentChars` after the response already
 * had content (text, or a call that finished) still names the cut call on its
 * error event, on every provider, so the agent can send it back to the model
 * as that tool's error instead of failing the run.
 */

const LIMIT = 100;
// Streamed in chunks, as a runaway is: the first ones fit, a later one crosses
// the limit and is not passed on.
const CHUNKS = ['{"body":"', ...Array.from({ length: 6 }, () => "a".repeat(40))];
const CUT_AT = 4; // 9 + 40 * 3 = 129 characters, past the limit

const frame = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

// --- Responses (OpenAI, Azure OpenAI) ---------------------------------------

const responsesCallAdded = (n: number, name: string) =>
  frame({
    type: "response.output_item.added",
    item: { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name },
  });
const responsesArgs = (n: number, delta: string) =>
  frame({ type: "response.function_call_arguments.delta", item_id: `fc_${n}`, delta });
const responsesArgsDone = (n: number, args: string) =>
  frame({ type: "response.function_call_arguments.done", item_id: `fc_${n}`, arguments: args });
const responsesCallDone = (n: number, name: string, args: string) =>
  frame({
    type: "response.output_item.done",
    item: { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name, arguments: args },
  });

const RESPONSES_CREATED = frame({ type: "response.created", response: { model: "gpt-x" } });
const responsesText = frame({ type: "response.output_text.delta", delta: "Writing it now." });
const responsesFinishedCall =
  responsesCallAdded(1, "lookup") +
  responsesArgs(1, '{"q":"a"}') +
  responsesArgsDone(1, '{"q":"a"}') +
  responsesCallDone(1, "lookup", '{"q":"a"}');
const responsesRunaway = responsesCallAdded(2, "write") + CHUNKS.map((c) => responsesArgs(2, c)).join("");

// --- Messages (Anthropic, Azure Anthropic) ----------------------------------

const MESSAGE_START = frame({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude-x",
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
});
const messagesText =
  frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  frame({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Writing it now." },
  }) +
  frame({ type: "content_block_stop", index: 0 });
const messagesTool = (index: number, id: string, name: string, json: string[], done: boolean) =>
  frame({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  }) +
  json
    .map((partial_json) =>
      frame({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }),
    )
    .join("") +
  (done ? frame({ type: "content_block_stop", index }) : "");
const messagesFinishedCall = messagesTool(0, "call_1", "lookup", ['{"q":"a"}'], true);
const messagesRunaway = (index: number) => messagesTool(index, "call_2", "write", CHUNKS, false);

// --- the providers, over a fake fetch -----------------------------------------

const sse = (raw: string) =>
  new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } });

/** Answers request `i` with `bodies[i]` (the last repeats). */
function fakeFetch(bodies: string[]) {
  let count = 0;
  const fetchImpl: FetchLike = async () => sse(bodies[Math.min(count++, bodies.length - 1)]!);
  return { fetchImpl, requests: () => count };
}

const config = { apiKey: "k", maxToolArgumentChars: LIMIT, maxRetries: 0 };

function withFetch<P extends AgentProvider>(provider: P, fetchImpl: FetchLike): P {
  const endpoint = (provider as any).endpoint.bind(provider);
  (provider as any).endpoint = () => ({ ...endpoint(), fetchImpl, sleep: async () => {} });
  return provider;
}

type Vendor = {
  name: string;
  make: (fetchImpl: FetchLike) => AgentProvider;
  text: string;
  finishedCall: string;
  /** A finished reply with text only, for the agent's follow-up step. */
  reply: string;
};

const vendors: Vendor[] = [
  {
    name: "OpenAIProvider",
    make: (f) => withFetch(new OpenAIProvider("gpt-5", config), f),
    text: RESPONSES_CREATED + responsesText + responsesRunaway,
    finishedCall: RESPONSES_CREATED + responsesFinishedCall + responsesRunaway,
    reply:
      RESPONSES_CREATED +
      responsesText +
      frame({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
  },
  {
    name: "AzureOpenAIProvider",
    make: (f) =>
      withFetch(new AzureOpenAIProvider("gpt-5", { ...config, endpoint: "https://r.openai.azure.com" }), f),
    text: RESPONSES_CREATED + responsesText + responsesRunaway,
    finishedCall: RESPONSES_CREATED + responsesFinishedCall + responsesRunaway,
    reply:
      RESPONSES_CREATED +
      responsesText +
      frame({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
  },
  {
    name: "AnthropicProvider",
    make: (f) => withFetch(new AnthropicProvider("claude-opus-5-5", config), f),
    text: MESSAGE_START + messagesText + messagesRunaway(1),
    finishedCall: MESSAGE_START + messagesFinishedCall + messagesRunaway(1),
    reply:
      MESSAGE_START +
      messagesText +
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
      frame({ type: "message_stop" }),
  },
  {
    name: "AzureAnthropicProvider",
    make: (f) =>
      withFetch(
        new AzureAnthropicProvider("claude-opus-5-5", {
          ...config,
          endpoint: "https://r.services.ai.azure.com/anthropic",
        }),
        f,
      ),
    text: MESSAGE_START + messagesText + messagesRunaway(1),
    finishedCall: MESSAGE_START + messagesFinishedCall + messagesRunaway(1),
    reply:
      MESSAGE_START +
      messagesText +
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
      frame({ type: "message_stop" }),
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

const CUT = { tool: "write", toolCallId: "call_2", limit: LIMIT, chars: CHUNKS.slice(0, CUT_AT).join("").length };

const lookups: string[] = [];
const tools = [
  AgentTool.create({
    name: "write",
    description: "Write a page",
    inputSchema: s.object({ body: s.string() }),
    execute: async ({ body }) => ({ wrote: body.length }),
  }),
  AgentTool.create({
    name: "lookup",
    description: "Look up",
    inputSchema: s.object({ q: s.string() }),
    execute: async ({ q }) => {
      lookups.push(q);
      return { found: q };
    },
  }),
];

const results = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

for (const vendor of vendors) {
  describe(`${vendor.name}: a call cut after earlier content (#1326)`, () => {
    test("after text, the error names the cut call", async () => {
      const { fetchImpl } = fakeFetch([vendor.text]);
      const events = await drain(vendor.make(fetchImpl));

      expect(events.some((e) => e.type === "text-delta")).toBe(true);
      expect(errorOf(events)?.toolArgumentsTooLong).toEqual(CUT);
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    });

    test("after a finished call, the error names the cut call, not the finished one", async () => {
      const { fetchImpl } = fakeFetch([vendor.finishedCall]);
      const events = await drain(vendor.make(fetchImpl));

      expect(events.some((e) => e.type === "tool-call" && e.toolCallId === "call_1")).toBe(true);
      expect(errorOf(events)?.toolArgumentsTooLong).toEqual(CUT);
    });

    test("the agent runs the finished call, answers the cut one with its error and asks again", async () => {
      lookups.length = 0;
      const { fetchImpl, requests } = fakeFetch([vendor.finishedCall, vendor.reply]);
      const agent = Agent.create({
        name: "writer",
        provider: vendor.make(fetchImpl),
        tools,
        onToolArgumentsTooLong: { toolError: 1 },
      });

      const result = await agent.stream({ messages: [], turn: { text: "write" } }).result();

      expect(result.error).toBeUndefined();
      expect(result.finishReason).toBe("stop");
      expect(requests()).toBe(2);
      expect(lookups).toEqual(["a"]);
      const byCall = Object.fromEntries(results(result.messages).map((part) => [part.toolCallId, part]));
      expect(byCall.call_1).toMatchObject({ status: "ok" });
      expect(byCall.call_2).toMatchObject({
        status: "error",
        error: expect.objectContaining({ code: "invalid_tool_input", message: expect.stringContaining("smaller calls") }),
      });
    });
  });
}

test("FallbackProvider passes the cut call on from a leg that had content", async () => {
  const { fetchImpl } = fakeFetch([vendors[0]!.finishedCall]);
  const provider = new FallbackProvider([{ provider: vendors[0]!.make(fetchImpl) }]);
  const events = await drain(provider);

  expect(errorOf(events)?.toolArgumentsTooLong).toEqual(CUT);
});
