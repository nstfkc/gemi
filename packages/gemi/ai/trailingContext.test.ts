process.env.SECRET ??= "trailing-context-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool, defaultPromptCacheKey } from "./Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import { AnthropicProvider, OpenAIProvider, type ProviderEvent, type ProviderToolSpec } from "./AgentProvider";
import { buildMessagesRequest } from "./providers/anthropicRequest";
import {
  capabilitiesForClaude,
  capabilitiesForModel,
  claudeRequestFeatures,
  responsesRequestFeatures,
} from "./providers/capabilities";
import { fakeProvider } from "./providers/fakeProvider";
import { buildResponsesRequest } from "./providers/request";
import { s } from "./Schema";
import { splitTurns } from "./contextWindow";
import { scriptedProvider } from "./testing";
import type { AgentMessage } from "./types";

// `trailingContext`, a cache key that stays put, and `activeTools` without a
// new tool list (#1345).

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];

const textOf = (message: AgentMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

const noop = (name: string) =>
  AgentTool.create({ name, description: `does ${name}`, inputSchema: s.object({}), execute: async () => "ok" });

/** A fake provider that says it places the trailing context, or holds a call to `allowedTools`, itself. */
function capable(features: { trailingContext?: boolean; allowedTools?: boolean }, ...scripts: ProviderEvent[][]) {
  const provider = fakeProvider(...scripts);
  Object.assign(provider.capabilities, features);
  return provider;
}

describe("trailingContext on a run", () => {
  test("a provider that does not place it is sent it as a last user message, which is never stored", async () => {
    const provider = fakeProvider(say("hi"));
    const agent = Agent.create({ name: "screen", provider });
    const result = await agent
      .stream({ messages: [], turn: { text: "hello" }, trailingContext: "The person is on the pricing page." })
      .result();
    const sent = provider.calls[0]!;
    expect(sent.trailingContext).toBeUndefined();
    expect(sent.messages.map(textOf)).toEqual(["hello", "The person is on the pricing page."]);
    expect(result.messages.map(textOf)).toEqual(["hello", "hi"]);
  });

  test("a provider that places it gets it as a parameter, after an unchanged conversation", async () => {
    const provider = capable({ trailingContext: true }, say("hi"));
    await Agent.create({ name: "screen", provider })
      .stream({ messages: [], turn: { text: "hello" }, trailingContext: "Pricing page." })
      .result();
    expect(provider.calls[0]!.trailingContext).toBe("Pricing page.");
    expect(provider.calls[0]!.messages.map(textOf)).toEqual(["hello"]);
  });

  test("prepareStep sees it and can change it for one call; an empty answer sends none", async () => {
    const seen: (string | undefined)[] = [];
    const provider = capable(
      { trailingContext: true },
      [{ type: "tool-call", toolCallId: "c1", name: "look", args: "{}" }, finish()],
      say("done"),
    );
    const agent = Agent.create({
      name: "screen",
      provider,
      tools: [noop("look")],
      prepareStep: ({ step, trailingContext }) => {
        seen.push(trailingContext);
        return step === 2 ? { trailingContext: "" } : { trailingContext: `${trailingContext} Step ${step}.` };
      },
    });
    await agent.stream({ messages: [], turn: { text: "go" }, trailingContext: "Home." }).result();
    expect(seen).toEqual(["Home.", "Home."]);
    expect(provider.calls.map((call) => call.trailingContext)).toEqual(["Home. Step 1.", undefined]);
  });

  test("is not handed down to a sub-run", async () => {
    const subProvider = capable({ trailingContext: true }, say("sub answer"));
    const sub = Agent.create({ name: "helper", provider: subProvider });
    const ask = AgentTool.create({
      name: "ask",
      description: "Ask the helper",
      inputSchema: s.object({}),
      execute: async (_input, ctx) => (await ctx.runAgent(sub, { prompt: "help" })).finishReason,
    });
    const provider = capable(
      { trailingContext: true },
      [{ type: "tool-call", toolCallId: "c1", name: "ask", args: "{}" }, finish()],
      say("done"),
    );
    await Agent.create({ name: "lead", provider, tools: [ask] })
      .stream({ messages: [], turn: { text: "go" }, trailingContext: "Home." })
      .result();
    expect(subProvider.calls[0]!.trailingContext).toBeUndefined();
  });

  test("AgentController.trailingContext() is sent with every turn, from the request", async () => {
    const provider = capable({ trailingContext: true }, say("hi"));
    const store = new MemoryAgentStore();
    class Chat extends AgentController<any, { page?: string }> {
      agent = Agent.create({ name: "chat", provider }) as any;
      store = store;
      liveRuns = new MemoryLiveRuns();
      protected trailingContext(_req: HttpRequest<any, any>, { body }: { body: { page?: string } }) {
        return body.page ? `The person is on ${body.page}.` : undefined;
      }
    }
    const { threadId } = await store.createThread({});
    await (await Chat.startTurn({ threadId, text: "hello", body: { page: "settings" } })).result();
    expect(provider.calls[0]!.trailingContext).toBe("The person is on settings.");
    expect((await store.loadThread(threadId))!.map(textOf)).toEqual(["hello", "hi"]);
  });
});

describe("the request prefix across turns (#1345)", () => {
  const callB = (id: string): ProviderEvent[] => [{ type: "tool-call", toolCallId: id, name: "b", args: "{}" }, finish()];
  /** Two turns with different trailing text, the first step of each narrowed to "b". */
  async function twoTurns(features: { trailingContext?: boolean; allowedTools?: boolean }) {
    const provider = capable(features, callB("c1"), say("one"), say("two"));
    const agent = Agent.create({
      name: "prefix",
      instructions: "You help.",
      provider,
      tools: [noop("a"), noop("b")],
      prepareStep: ({ step }) => (step === 1 ? { activeTools: ["b"] } : {}),
    });
    const first = await agent.stream({ messages: [], turn: { text: "first" }, trailingContext: "Screen: home, 09:00." }).result();
    const second = await agent
      .stream({ messages: first.messages, turn: { text: "second" }, trailingContext: "Screen: pricing, 09:05." })
      .result();
    return { provider, first, second };
  }

  test("system prompt and tools are byte-equal on every call; turn 2 starts with turn 1 as stored", async () => {
    const { provider, first } = await twoTurns({ trailingContext: true, allowedTools: true });
    expect(provider.calls).toHaveLength(3);
    expect(new Set(provider.calls.map((call) => call.systemPrompt)).size).toBe(1);
    expect(new Set(provider.calls.map((call) => JSON.stringify(call.tools))).size).toBe(1);
    const turn2 = provider.calls[2]!.messages;
    expect(JSON.stringify(turn2.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
    const sent = JSON.stringify(provider.calls.map((call) => call.messages));
    expect(sent).not.toContain("Screen:");
    expect(provider.calls.map((call) => call.trailingContext)).toEqual([
      "Screen: home, 09:00.",
      "Screen: home, 09:00.",
      "Screen: pricing, 09:05.",
    ]);
  });

  test("on the Responses request, each step's input is a prefix of the next once the trailing item is left out", async () => {
    const model = "gpt-5.4";
    const { provider } = await twoTurns(responsesRequestFeatures(model));
    const inputs = provider.calls.map((call) => {
      const body = buildResponsesRequest(call as any, {
        model,
        capabilities: { ...capabilitiesForModel(model), ...responsesRequestFeatures(model) },
      });
      expect(body.input.at(-1)).toMatchObject({ role: "developer" });
      return { input: body.input.slice(0, -1), head: JSON.stringify([body.instructions, body.tools]) };
    });
    expect(new Set(inputs.map((entry) => entry.head)).size).toBe(1);
    for (let i = 1; i < inputs.length; i++) {
      const before = inputs[i - 1]!.input;
      expect(JSON.stringify(inputs[i]!.input.slice(0, before.length))).toBe(JSON.stringify(before));
    }
  });

  test("the fallback message is in the current turn, so the turn read off the request is the person's", async () => {
    const provider = fakeProvider(say("hi"));
    await Agent.create({ name: "screen", provider })
      .stream({ messages: [], turn: { text: "hello" }, trailingContext: "Pricing page." })
      .result();
    const sent = provider.calls[0]!.messages;
    expect(sent.at(-1)!.turn).toBe(sent[0]!.id);
    expect(splitTurns(sent)).toHaveLength(1);
  });

  test("a scripted provider gets it as a parameter, and its turn is the person's message", async () => {
    const provider = scriptedProvider(["hi"]);
    await Agent.create({ name: "screen", provider })
      .stream({ messages: [], turn: { text: "hello" }, trailingContext: "Pricing page." })
      .result();
    expect(provider.calls[0]!.trailingContext).toBe("Pricing page.");
    expect(provider.calls[0]!.turn?.text).toBe("hello");
  });
});

describe("the default promptCacheKey", () => {
  test("stays the same when a turn adds instructions or a step narrows the tools", async () => {
    const provider = fakeProvider(
      [{ type: "tool-call", toolCallId: "c1", name: "a", args: "{}" }, finish()],
      say("done"),
      say("again"),
    );
    const agent = Agent.create({
      name: "keyed",
      provider,
      instructions: "You help.",
      tools: [noop("a"), noop("b")],
      prepareStep: ({ step }) => (step === 2 ? { activeTools: ["b"] } : undefined),
    });
    await agent.stream({ messages: [], turn: { text: "one" }, instructions: "The user is Ada." }).result();
    await agent.stream({ messages: [], turn: { text: "two" }, instructions: "The user is Grace." }).result();
    const keys = new Set(provider.calls.map((call) => call.promptCacheKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^keyed-[0-9a-f]{16}$/);
  });

  test("changes with the agent's own instructions", () => {
    expect(defaultPromptCacheKey("a", "one", [])).not.toBe(defaultPromptCacheKey("a", "two", []));
  });
});

describe("activeTools on a step", () => {
  const twoTools = () => [noop("a"), noop("b")];
  const narrowing = (provider: ReturnType<typeof fakeProvider>) =>
    Agent.create({ name: "narrow", provider, tools: twoTools(), prepareStep: () => ({ activeTools: ["b"] }) });

  test("a provider that takes allowedTools is sent the full list and the names this call may use", async () => {
    const provider = capable({ allowedTools: true }, say("ok"));
    await narrowing(provider).stream({ messages: [], turn: { text: "go" } }).result();
    expect(provider.calls[0]!.tools!.map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(provider.calls[0]!.allowedTools).toEqual(["b"]);
  });

  test("any other provider is sent the narrowed list, as before", async () => {
    const provider = fakeProvider(say("ok"));
    await narrowing(provider).stream({ messages: [], turn: { text: "go" } }).result();
    expect(provider.calls[0]!.tools!.map((tool) => tool.name)).toEqual(["b"]);
    expect(provider.calls[0]!.allowedTools).toBeUndefined();
  });

  test("a call to a tool left out is still refused with allowedTools", async () => {
    const provider = capable(
      { allowedTools: true },
      [{ type: "tool-call", toolCallId: "c1", name: "a", args: "{}" }, finish()],
      say("ok"),
    );
    const result = await narrowing(provider).stream({ messages: [], turn: { text: "go" } }).result();
    const output = result.messages.flatMap((message) => message.content).find((part) => part.type === "tool-result");
    expect(output).toMatchObject({ toolCallId: "c1", status: "error" });
  });
});

const spec = (name: string): ProviderToolSpec => ({
  name,
  description: `does ${name}`,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  strict: true,
});
const user = (text: string): AgentMessage => ({
  id: `m_${text}`,
  role: "user",
  content: [{ type: "text", text }],
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("the Responses request", () => {
  const build = (params: Record<string, unknown>, model = "gpt-5.4") =>
    buildResponsesRequest({ messages: [user("hello")], ...params } as any, {
      model,
      capabilities: { ...capabilitiesForModel(model), ...responsesRequestFeatures(model) },
    });

  test("sends the trailing context as a last developer message", () => {
    const body = build({ trailingContext: "Pricing page." });
    expect(body.input.at(-1)).toEqual({
      role: "developer",
      content: [{ type: "input_text", text: "Pricing page." }],
    });
    expect(body.input).toHaveLength(2);
  });

  test("holds a narrowed call with allowed_tools and the full list", () => {
    const body = build({ tools: [spec("a"), spec("b")], allowedTools: ["b"] });
    expect(body.tools!.map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(body.tool_choice).toEqual({ type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "b" }] });
    expect(build({ tools: [spec("a"), spec("b")], allowedTools: ["b"], toolChoice: "required" }).tool_choice).toMatchObject({
      mode: "required",
    });
    expect(build({ tools: [spec("a"), spec("b")], allowedTools: ["b"], toolChoice: { name: "b" } }).tool_choice).toEqual({
      type: "function",
      name: "b",
    });
  });

  test("narrows a list with namespaces instead, which allowed_tools cannot name", () => {
    const body = build({
      tools: [spec("a"), { name: "crm", description: "CRM", tools: [spec("getOrder"), spec("listOrders")] }],
      allowedTools: ["getOrder"],
    });
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.stringify(body.tools)).toContain("getOrder");
    expect(JSON.stringify(body.tools)).not.toContain("listOrders");
    expect(JSON.stringify(body.tools)).not.toContain('"name":"a"');
  });

  test("allowedTools is declared for gpt-5 models and unknown ids, not for older ones", () => {
    expect(new OpenAIProvider("gpt-5.4", { apiKey: "k" }).capabilities).toMatchObject({
      trailingContext: true,
      allowedTools: true,
    });
    expect(responsesRequestFeatures("gpt-4.1").allowedTools).toBe(false);
    expect(responsesRequestFeatures("my-deployment").allowedTools).toBe(true);
  });
});

describe("the Messages request", () => {
  const build = (messages: AgentMessage[], trailingContext?: string) =>
    buildMessagesRequest({ messages, trailingContext } as any, {
      model: "claude-opus-5-5",
      modelId: "claude-opus-5-5",
      capabilities: { ...capabilitiesForClaude("claude-opus-5-5"), ...claudeRequestFeatures() },
      forcedToolChoice: false,
      blockBinding: true,
    });

  test("puts the trailing context after the last block, with the cache breakpoint before it", () => {
    const body = build([user("hello")], "Pricing page.");
    const content = body.messages.at(-1)!.content as any[];
    expect(content.map((block) => block.text)).toEqual(["hello", "Pricing page."]);
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(content[1].cache_control).toBeUndefined();
  });

  test("the cached prefix is the same whatever the trailing context says", () => {
    const strip = (body: ReturnType<typeof build>) => {
      const copy = structuredClone(body);
      (copy.messages.at(-1)!.content as any[]).pop();
      return copy;
    };
    expect(strip(build([user("hello")], "one"))).toEqual(strip(build([user("hello")], "two")));
  });

  test("after an assistant message, it follows the continuation the request adds", () => {
    const assistant: AgentMessage = {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "cut" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      finishReason: "length",
    };
    const body = build([user("hello"), assistant], "Pricing page.");
    const content = body.messages.at(-1)!.content as any[];
    expect(body.messages.at(-1)!.role).toBe("user");
    expect(content.at(-1)).toEqual({ type: "text", text: "Pricing page." });
    expect(content.at(-2).cache_control).toEqual({ type: "ephemeral" });
  });

  test("the Anthropic provider places it, and narrows tools itself", () => {
    const provider = new AnthropicProvider("claude-opus-5-5", { apiKey: "k" });
    expect(provider.capabilities.trailingContext).toBe(true);
    expect(provider.capabilities.allowedTools).toBeFalsy();
  });
});
