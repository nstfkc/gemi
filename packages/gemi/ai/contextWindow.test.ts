process.env.SECRET ??= "context-window-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool, type PrepareStepContext } from "./Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import type { ProviderEvent, ProviderToolNamespace } from "./AgentProvider";
import {
  DEFAULT_CONTEXT_WINDOW_NOTE,
  messageSize,
  splitTurns,
  turnStarts,
  windowMessages,
} from "./contextWindow";
import { fakeProvider } from "./providers/fakeProvider";
import { toResponsesInput } from "./providers/request";
import { s } from "./Schema";
import type { AgentMessage, ToolCallPart } from "./types";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

const msg = (
  id: string,
  role: AgentMessage["role"],
  text: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
  finishReason: "stop",
  ...extra,
});

/** `n` turns of a user message and an answer, ids `u<i>` and `a<i>`. */
const thread = (n: number, text = "x"): AgentMessage[] =>
  Array.from({ length: n }, (_, i) => [
    msg(`u${i}`, "user", `${text} ${i}`),
    msg(`a${i}`, "assistant", `answer ${i}`),
  ]).flat();

const ids = (messages: readonly AgentMessage[]) => messages.map((m) => m.id);
const textOf = (message: AgentMessage) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));

/** An assistant message whose tool call showed a file in message `shownId`. */
const showing = (id: string, shownId: string): AgentMessage => ({
  ...msg(id, "assistant", ""),
  content: [
    {
      type: "tool-call",
      toolCallId: `call_${id}`,
      name: "show",
      input: {},
      attachments: [{ shown: { messageId: shownId } } as any],
    },
    { type: "tool-result", toolCallId: `call_${id}`, name: "show", status: "ok", output: "shown" },
  ] as any,
});

describe("turnStarts / splitTurns", () => {
  test("a turn starts at each user message, and index 0 always starts one", () => {
    const messages = [
      msg("a-1", "assistant", "hello, how can I help?"),
      msg("u0", "user", "hi"),
      msg("a0", "assistant", "hey"),
      msg("u1", "user", "more"),
    ];
    expect(turnStarts(messages)).toEqual([0, 1, 3]);
    expect(splitTurns(messages).map(ids)).toEqual([["a-1"], ["u0", "a0"], ["u1"]]);
    expect(turnStarts([])).toEqual([]);
  });

  test("a file message a tool injected is user role but not a turn", () => {
    const messages = [
      msg("u0", "user", "look at it"),
      showing("a0", "f0"),
      msg("f0", "user", "the file"),
      msg("a1", "assistant", "seen"),
      msg("u1", "user", "next"),
    ];
    expect(splitTurns(messages).map(ids)).toEqual([["u0", "a0", "f0", "a1"], ["u1"]]);
  });
});

describe("windowMessages", () => {
  test("no limits, or a thread within them, is sent whole and as the same objects", () => {
    const messages = thread(5);
    const all = windowMessages(messages);
    expect(all.messages).toEqual(messages);
    expect(all.messages[0]).toBe(messages[0]);
    expect(all.omittedTurns).toBe(0);
    expect(windowMessages(messages, { maxTurns: 5 }).messages).toEqual(messages);
  });

  test("maxTurns cuts at a step-aligned turn, so the prefix holds from turn to turn", () => {
    // 41 turns over a limit of 40: the cut goes to turn 10 (step 10), not 1.
    const at41 = windowMessages(thread(41), { maxTurns: 40 });
    expect(at41.omittedTurns).toBe(10);
    expect(at41.messages[0]!.id).toBe("u10");
    expect(at41.start).toBe(20);

    // Every later turn up to 50 sends the same first message.
    for (let n = 42; n <= 50; n++) {
      expect(windowMessages(thread(n), { maxTurns: 40 }).messages[0]!.id).toBe("u10");
    }
    // The 51st moves it by another step.
    expect(windowMessages(thread(51), { maxTurns: 40 }).messages[0]!.id).toBe("u20");
  });

  test("step 1 slides one turn at a time", () => {
    expect(windowMessages(thread(41), { maxTurns: 40, step: 1 }).messages[0]!.id).toBe("u1");
  });

  test("maxBytes and maxTokens bound the size, at a step-aligned turn", () => {
    const messages = thread(30);
    const perTurn = messageSize(messages[0]!) + messageSize(messages[1]!);
    // Room for about 12 turns: the first aligned cut that fits is turn 20.
    const result = windowMessages(messages, { maxBytes: perTurn * 12 + 5 });
    expect(result.messages[0]!.id).toBe("u20");
    expect(windowMessages(messages, { maxTokens: Math.ceil((perTurn * 12 + 5) / 4) }).start).toBe(
      result.start,
    );
  });

  test("a turn too big for any aligned cut falls back to the earliest turn that fits", () => {
    const messages = [
      ...thread(3),
      msg("u3", "user", "y".repeat(1000)),
      msg("a3", "assistant", "ok"),
    ];
    const size = messageSize(messages[6]!) + messageSize(messages[7]!);
    // Turn 3 alone fits; no step-aligned cut (0) does.
    expect(windowMessages(messages, { maxBytes: size + 1 }).messages.map((m) => m.id)).toEqual([
      "u3",
      "a3",
    ]);
  });

  test("the latest turn is always kept, even over budget", () => {
    const messages = [...thread(2), msg("u2", "user", "z".repeat(5000))];
    const result = windowMessages(messages, { maxBytes: 10 });
    expect(ids(result.messages)).toEqual(["u2"]);
  });

  test("the first kept turn says earlier turns are left out, on a copy", () => {
    const messages = thread(12);
    const result = windowMessages(messages, { maxTurns: 5, step: 5 });
    expect(result.messages[0]!.id).toBe("u10");
    expect(textOf(result.messages[0]!)).toEqual([DEFAULT_CONTEXT_WINDOW_NOTE, "x 10"]);
    // The input is untouched.
    expect(textOf(messages[20]!)).toEqual(["x 10"]);

    expect(
      textOf(windowMessages(messages, { maxTurns: 5, step: 5, note: false }).messages[0]!),
    ).toEqual(["x 10"]);
    const custom = windowMessages(messages, {
      maxTurns: 5,
      step: 5,
      note: ({ turns, messages }) => `[${turns} turns, ${messages} messages left out]`,
    });
    expect(textOf(custom.messages[0]!)[0]).toBe("[10 turns, 20 messages left out]");
  });

  test("never separates a tool call from its result or a shown file from its call", () => {
    const messages = [
      msg("u0", "user", "one"),
      msg("a0", "assistant", "ok"),
      msg("u1", "user", "show me"),
      showing("a1", "f1"),
      msg("f1", "user", "file"),
      msg("a1b", "assistant", "here"),
      msg("u2", "user", "thanks"),
    ];
    for (let maxTurns = 1; maxTurns <= 3; maxTurns++) {
      const kept = ids(windowMessages(messages, { maxTurns, step: 1 }).messages);
      // Either the whole of turn 1 or none of it.
      const turn1 = ["u1", "a1", "f1", "a1b"].filter((id) => kept.includes(id));
      expect([0, 4]).toContain(turn1.length);
    }
  });

  test("system messages before the cut stay, at the front", () => {
    const messages = [msg("s0", "system", "be brief"), ...thread(4)];
    const result = windowMessages(messages, { maxTurns: 1, step: 1, note: false });
    expect(ids(result.messages)).toEqual(["s0", "u3", "a3"]);
  });

  describe("tool searches (#777)", () => {
    const call = (id: string, extra: Partial<ToolCallPart> = {}): AgentMessage => ({
      ...msg(id, "assistant", ""),
      content: [
        {
          type: "tool-call",
          toolCallId: `call_${id}`,
          name: "getOrder",
          input: { id: 1 },
          namespace: "crm",
          ...extra,
        },
        {
          type: "tool-result",
          toolCallId: `call_${id}`,
          name: "getOrder",
          status: "ok",
          output: "order",
        },
      ] as any,
    });
    const search = { namespaces: ["crm"], loaded: [], arguments: { paths: ["crm"] } };
    const history = () => [
      msg("u0", "user", "find order"),
      call("a0", { toolSearches: [search] }),
      msg("u1", "user", "and again"),
      call("a1"),
    ];

    test("a kept namespaced call gets back the search a dropped turn ran", () => {
      const messages = history();
      const result = windowMessages(messages, { maxTurns: 1, step: 1 });
      expect(ids(result.messages)).toEqual(["u1", "a1"]);
      const part = result.messages[1]!.content[0] as ToolCallPart;
      expect(part.toolSearches).toEqual([search]);
      // On a copy.
      expect((messages[3]!.content[0] as ToolCallPart).toolSearches).toBeUndefined();

      // And the request replays it before the call.
      const crm: ProviderToolNamespace = {
        name: "crm",
        description: "CRM",
        tools: [
          {
            name: "getOrder",
            description: "Get an order",
            parameters: { type: "object", properties: {} },
            strict: false,
          } as any,
        ],
      } as any;
      const items = toResponsesInput(result.messages, { toolSearch: true } as any, [crm]);
      const types = items.map((item) => item.type);
      expect(types.indexOf("tool_search_output")).toBeLessThan(types.indexOf("function_call"));
      expect(items.find((item) => item.type === "function_call")).toMatchObject({
        namespace: "crm",
      });
    });

    test("nothing is carried when the kept turns already hold the search", () => {
      const messages = [
        ...history(),
        msg("u2", "user", "x"),
        call("a2", { toolSearches: [search] }),
      ];
      const result = windowMessages(messages, { maxTurns: 1, step: 1 });
      expect(result.messages[1]).toBe(messages[5]);
    });

    test("a deferred tool outside a namespace is matched by name", () => {
      const deferredSearch = { namespaces: [], loaded: ["lookup"] };
      const messages = [
        msg("u0", "user", "x"),
        call("a0", { namespace: undefined, name: "lookup", toolSearches: [deferredSearch] } as any),
        msg("u1", "user", "y"),
        call("a1", { namespace: undefined, name: "lookup" } as any),
      ];
      const part = windowMessages(messages, { maxTurns: 1, step: 1 }).messages[1]!
        .content[0] as ToolCallPart;
      expect(part.toolSearches).toEqual([deferredSearch]);
    });
  });
});

describe("Agent: contextWindow and prepareStep", () => {
  test("contextWindow bounds the request and nothing else", async () => {
    const provider = fakeProvider([{ type: "text-delta", delta: "hi" }, finish()]);
    const agent = Agent.create({
      name: "a",
      provider,
      contextWindow: { maxTurns: 2, step: 1, note: false },
    });
    const history = thread(5);
    const stored: AgentMessage[] = [];
    const result = await agent
      .stream({ messages: history, turn: { text: "now" }, onMessage: (m) => void stored.push(m) })
      .result();

    const sent = provider.calls[0]!.messages;
    expect(ids(sent).slice(0, 2)).toEqual(["u4", "a4"]);
    expect(sent).toHaveLength(3);
    expect(textOf(sent[2]!)).toEqual(["now"]);
    // The run reports every new message, and the history it was handed is
    // untouched.
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.messages).toHaveLength(2);
    expect(history).toHaveLength(10);
  });

  test("a stream's contextWindow overrides the agent's, and false turns it off", async () => {
    const provider = fakeProvider([finish()], [finish()]);
    const agent = Agent.create({ name: "a", provider, contextWindow: { maxTurns: 1, step: 1 } });
    await agent
      .stream({ messages: thread(5), turn: { text: "now" }, contextWindow: false })
      .result();
    expect(provider.calls[0]!.messages).toHaveLength(11);
    await agent
      .stream({
        messages: thread(5),
        turn: { text: "now" },
        contextWindow: { maxTurns: 3, step: 1 },
      })
      .result();
    expect(provider.calls[1]!.messages).toHaveLength(5);
  });

  test("prepareStep is called before every model call and changes only that call", async () => {
    const echo = AgentTool.create({
      name: "echo",
      description: "Echo",
      inputSchema: s.object({}),
      outputSchema: s.string(),
      execute: async () => "echoed",
    });
    const provider = fakeProvider(
      [{ type: "tool-call", toolCallId: "c1", name: "echo", args: "{}" }, finish()],
      [{ type: "text-delta", delta: "done" }, finish()],
    );
    const seen: PrepareStepContext[] = [];
    const agent = Agent.create({
      name: "a",
      provider,
      instructions: "base",
      tools: [echo],
      prepareStep: (ctx) => {
        seen.push(ctx);
        if (ctx.step === 1) {
          return { messages: ctx.messages.slice(-1), instructions: "step one" };
        }
      },
    });
    const result = await agent.stream({ messages: thread(3), turn: { text: "go" } }).result();

    expect(seen.map((ctx) => ctx.step)).toEqual([1, 2]);
    expect(seen[0]!.lastFinishReason).toBeUndefined();
    expect(seen[1]!.lastFinishReason).toBe("stop");
    expect(seen[1]!.lastStepUsage?.inputTokens).toBe(10);
    expect(seen[0]!.instructions).toBe("base");
    expect(seen[0]!.agent).toBe("a");
    expect(seen[0]!.depth).toBe(0);

    expect(provider.calls[0]!.messages).toHaveLength(1);
    expect(provider.calls[0]!.systemPrompt).toBe("step one");
    // Step two starts from the whole history again.
    expect(provider.calls[1]!.messages).toHaveLength(8);
    expect(provider.calls[1]!.systemPrompt).toBe("base");
    expect(result.finishReason).toBe("stop");
  });

  test("the stream's prepareStep runs after the agent's, on what it answered", async () => {
    const provider = fakeProvider([finish()]);
    const order: string[] = [];
    const agent = Agent.create({
      name: "a",
      provider,
      contextWindow: { maxTurns: 2, step: 1, note: false },
      prepareStep: (ctx) => {
        order.push(`agent:${ctx.messages.length}:${ctx.history.length}`);
        return { messages: ctx.messages.slice(-1) };
      },
    });
    await agent
      .stream({
        messages: thread(4),
        turn: { text: "go" },
        prepareStep: (ctx) => void order.push(`stream:${ctx.messages.length}`),
      })
      .result();
    expect(order).toEqual(["agent:3:9", "stream:1"]);
    expect(provider.calls[0]!.messages).toHaveLength(1);
  });

  test("a prepareStep that throws fails the run", async () => {
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({
      name: "a",
      provider,
      logErrors: false,
      prepareStep: () => {
        throw new Error("boom");
      },
    });
    const result = await agent.stream({ messages: [], turn: { text: "go" } }).result();
    expect(result.finishReason).toBe("error");
    expect(result.error?.message).toContain("prepareStep threw: boom");
    expect(provider.calls).toHaveLength(0);
  });

  test("a sub-run uses its own agent's window, and not the parent stream's prepareStep", async () => {
    const subProvider = fakeProvider([{ type: "text-delta", delta: "sub" }, finish()]);
    const subSteps: number[] = [];
    const sub = Agent.create({
      name: "sub",
      provider: subProvider,
      contextWindow: { maxTurns: 1, step: 1, note: false },
      prepareStep: (ctx) => void subSteps.push(ctx.depth),
    });
    const delegate = AgentTool.create({
      name: "delegate",
      description: "Delegate",
      inputSchema: s.object({}),
      outputSchema: s.string(),
      execute: async (_input: any, ctx: any) => {
        await ctx.runAgent(sub, { messages: thread(3), prompt: "go" });
        return "ok";
      },
    });
    const provider = fakeProvider(
      [{ type: "tool-call", toolCallId: "c1", name: "delegate", args: "{}" }, finish()],
      [finish()],
    );
    const parentSteps: number[] = [];
    const agent = Agent.create({ name: "parent", provider, tools: [delegate] });
    await agent
      .stream({
        messages: [],
        turn: { text: "go" },
        prepareStep: (ctx) => void parentSteps.push(ctx.depth),
      })
      .result();
    expect(parentSteps).toEqual([0, 0]);
    expect(subSteps).toEqual([1]);
    expect(ids(subProvider.calls[0]!.messages).length).toBe(1);
  });
});

describe("AgentController: contextWindow and prepareStep", () => {
  function jsonRequest(body: unknown) {
    const raw = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return new HttpRequest(raw, {}, "api", "/chat");
  }

  async function setup(
    configure: (Base: any) => any,
    turns = 6,
  ): Promise<{
    controller: AgentController<any>;
    store: MemoryAgentStore;
    threadId: string;
    provider: any;
  }> {
    const provider = fakeProvider([{ type: "text-delta", delta: "answer" }, finish()]);
    const agent = Agent.create({ name: "chat", provider });
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, thread(turns));
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
    }
    const Configured = configure(Chat);
    return { controller: new Configured(), store, threadId, provider };
  }

  test("a threaded turn sends the window and stores the whole thread", async () => {
    const { controller, store, threadId, provider } = await setup(
      (Chat) =>
        class extends Chat {
          contextWindow = { maxTurns: 2, step: 1 };
        },
    );
    const response = await controller.stream(jsonRequest({ threadId, turn: { text: "now" } }));
    await response.text();
    await settle();

    const sent = provider.calls[0]!.messages as AgentMessage[];
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(textOf(sent[0]!)[0]).toBe(DEFAULT_CONTEXT_WINDOW_NOTE);
    // The store holds every turn, and no note.
    const held = (await store.loadThread(threadId))!;
    expect(held).toHaveLength(14);
    expect(held.every((m) => !textOf(m).includes(DEFAULT_CONTEXT_WINDOW_NOTE))).toBe(true);
  });

  test("prepareStep on the controller gets the request and the hook context", async () => {
    const seen: { step: number; threadId?: string; runId: string }[] = [];
    const { controller, threadId, provider } = await setup(
      (Chat) =>
        class extends Chat {
          prepareStep(step: PrepareStepContext, ctx: any) {
            seen.push({ step: step.step, threadId: ctx.threadId, runId: ctx.runId });
            return { messages: step.messages.slice(-1) };
          }
        },
    );
    const response = await controller.stream(jsonRequest({ threadId, turn: { text: "now" } }));
    await response.text();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.threadId).toBe(threadId);
    expect(seen[0]!.runId).toMatch(/^run_/);
    expect(provider.calls[0]!.messages).toHaveLength(1);
  });

  test("a stateless turn is windowed too", async () => {
    const { controller, provider } = await setup(
      (Chat) =>
        class extends Chat {
          contextWindow = { maxTurns: 1, step: 1, note: false };
        },
    );
    const response = await controller.stream(
      jsonRequest({ messages: thread(3), turn: { text: "now" } }),
    );
    await response.text();
    expect(provider.calls[0]!.messages).toHaveLength(1);
  });
});
