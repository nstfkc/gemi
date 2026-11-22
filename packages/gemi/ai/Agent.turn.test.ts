process.env.SECRET ??= "agent-turn-test-secret";

import { describe, expect, test, vi } from "vitest";

import { Agent, AgentTool } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  defineAgentHooks,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "./types";

// `AgentMessage.turn` and `AgentRun.turn` (#1339): every message a run writes
// names the turn it answers.

const finish = (reason: "stop" | "tool-calls" = "stop"): ProviderEvent => ({
  type: "finish",
  reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];

const draw = AgentTool.create({
  name: "draw",
  description: "Draw a picture",
  inputSchema: s.object({ count: s.number() }),
  requiresApproval: true,
  execute: async ({ count }: { count: number }) => ({ drawn: count }),
});

async function drain(stream: ReturnType<Agent<any>["stream"]>) {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events };
}

describe("AgentMessage.turn (#1339)", () => {
  test("a new turn is its own message's id, on that message and on everything the run writes", async () => {
    const agent = Agent.create({ name: "turns", provider: fakeProvider(say("hello")) });
    const stream = agent.stream({ messages: [], turn: { text: "hi" } });
    const { result } = await drain(stream);
    const [question, answer] = result.messages as AgentMessage[];
    expect(question!.turn).toBe(question!.id);
    expect(answer!.turn).toBe(question!.id);
    expect(stream.turn).toEqual({ id: question!.id });
  });

  test("answers to tool calls carry on the turn that asked them, and say so", async () => {
    const agent = Agent.create({
      name: "turns",
      provider: fakeProvider(
        [{ type: "tool-call", toolCallId: "c1", name: "draw", args: '{"count":2}' }, finish("tool-calls")],
        say("drawn"),
      ),
      tools: [draw],
    });
    const first = await drain(agent.stream({ messages: [], turn: { text: "draw" } }));
    const pending = (first.events.find((event) => event.type === "awaiting-input") as any)
      .pending as PendingToolCall[];
    const asked = first.result.messages[0]!.id;
    // Another turn stored since, as a parallel run would: the answer still
    // belongs to the turn that asked.
    const later: AgentMessage[] = [
      { id: "u_other", role: "user", content: [{ type: "text", text: "unrelated" }], createdAt: "", turn: "u_other" },
      { id: "a_other", role: "assistant", content: [{ type: "text", text: "sure" }], createdAt: "", turn: "u_other", finishReason: "stop" },
    ];

    const stream = agent.stream({
      messages: [...first.result.messages, ...later],
      turn: { toolResults: [{ toolCallId: "c1", signature: pending[0]!.signature, approve: true }] },
    });
    const { result } = await drain(stream);
    expect(stream.turn).toEqual({ id: asked, continues: true, answers: ["c1"] });
    // The message that asked, amended with the result, and the reply after it.
    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((message) => message.turn === asked)).toBe(true);
  });

  test("a thread stored without turn is continued from its last turn start, found as before", async () => {
    const agent = Agent.create({ name: "turns", provider: fakeProvider(say("more")) });
    const old: AgentMessage[] = [
      { id: "u0", role: "user", content: [{ type: "text", text: "go on" }], createdAt: "" },
      { id: "a0", role: "assistant", content: [{ type: "text", text: "cut" }], createdAt: "", finishReason: "length" },
    ];
    const stream = agent.stream({ messages: old });
    const { result } = await drain(stream);
    expect(stream.turn).toEqual({ id: "u0", continues: true });
    expect(result.messages.at(-1)!.turn).toBe("u0");
  });

  test("what the run reads from its inbox joins its turn rather than starting one", async () => {
    const texts = [["and make it blue"]];
    const agent = Agent.create({
      name: "turns",
      provider: fakeProvider(
        [{ type: "tool-call", toolCallId: "c1", name: "note", args: "{}" }, finish("tool-calls")],
        say("done"),
      ),
      tools: [
        AgentTool.create({
          name: "note",
          description: "Note",
          inputSchema: s.object({}),
          execute: async () => "ok",
        }),
      ],
    });
    const stream = agent.stream({
      messages: [],
      turn: { text: "write the hero" },
      inbox: { take: () => texts.shift() ?? [] },
    });
    const { result } = await drain(stream);
    const question = result.messages[0]!;
    const read = result.messages.find((message) =>
      message.content.some((part) => part.type === "text" && part.text === "and make it blue"),
    );
    expect(read?.role).toBe("user");
    expect(read?.turn).toBe(question.id);
    expect(result.messages.every((message) => message.turn === question.id)).toBe(true);
  });

  test("hooks read the turn from their context: a new one, then the answer that carries it on", async () => {
    const store = new MemoryAgentStore();
    const seen: unknown[] = [];
    class Chat extends AgentController {
      agent = Agent.create({
        name: "turns",
        provider: fakeProvider(
          [{ type: "tool-call", toolCallId: "c1", name: "draw", args: '{"count":2}' }, finish("tool-calls")],
          say("drawn"),
        ),
        tools: [draw],
      }) as any;
      store = store;
      liveRuns = new MemoryLiveRuns();
      hooks = defineAgentHooks({
        onStreamComplete: (_result, ctx: AgentHookContext) => {
          seen.push(ctx.turn);
        },
      });
    }
    const { threadId } = await store.createThread({});
    const first = await (await Chat.startTurn({ threadId, text: "draw" })).result();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const asked = (await store.loadThread(threadId))![0]!.id;
    expect(seen[0]).toEqual({ id: asked });

    await (
      await Chat.startTurn({
        threadId,
        turn: { toolResults: [{ toolCallId: "c1", signature: first.pending[0]!.signature, approve: true }] },
      })
    ).result();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toEqual({ id: asked, continues: true, answers: ["c1"] });
  });
});
