process.env.SECRET ??= "agent-test-secret";

import { describe, expect, test } from "vitest";
import { Agent, AgentTool } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { openPending } from "./client/reducer";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, ClientTurn, PendingToolCall } from "./types";

// #1052: the calls a turn ends waiting on are kept on its message, so a page
// opened later (a reload, another tab) can answer them.

const toolCall = (toolCallId: string, name: string, args: unknown): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: JSON.stringify(args),
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];

const ask = AgentTool.ask({
  name: "ask",
  description: "Ask the user something",
  outputSchema: s.object({ answer: s.string() }),
});

function refundTool(refunded: string[]) {
  return AgentTool.create({
    name: "refund",
    description: "Refund an order",
    inputSchema: s.object({ orderId: s.string() }),
    requiresApproval: true,
    execute: async ({ orderId }: { orderId: string }) => {
      refunded.push(orderId);
      return { refunded: orderId };
    },
  });
}

async function turn(
  agent: Agent<any, any, any>,
  messages: AgentMessage[],
  next: ClientTurn,
): Promise<{
  messages: AgentMessage[];
  finishReason: string;
  events: AgentStreamEvent[];
  pending: PendingToolCall[];
}> {
  const run = agent.stream({ messages, turn: next });
  const events: AgentStreamEvent[] = [];
  const done = (async () => {
    for await (const event of run as AsyncIterable<AgentStreamEvent>) events.push(event);
  })();
  const result = await run.result();
  await done;
  const awaiting = events.find((event) => event.type === "awaiting-input") as any;
  return {
    messages: result.messages as AgentMessage[],
    finishReason: result.finishReason,
    events,
    pending: awaiting?.pending ?? [],
  };
}

/** The transcript a store holds after a turn: the history, upserted by id. */
function stored(history: AgentMessage[], produced: AgentMessage[]): AgentMessage[] {
  const thread = [...history];
  for (const message of produced) {
    const at = thread.findIndex((held) => held.id === message.id);
    if (at === -1) thread.push(message);
    else thread[at] = message;
  }
  return JSON.parse(JSON.stringify(thread));
}

describe("AgentMessage.pending (#1052)", () => {
  test("a turn that ends awaiting-input keeps the frame's calls on its message", async () => {
    const agent = Agent.create({
      name: "support",
      provider: fakeProvider([toolCall("c1", "refund", { orderId: "o1" }), finish()]),
      tools: [refundTool([])],
    });
    const first = await turn(agent, [], { text: "refund o1" });

    expect(first.finishReason).toBe("awaiting-input");
    const asking = first.messages.find((message) => message.finishReason === "awaiting-input")!;
    expect(asking.pending).toEqual(first.pending);
    expect(asking.pending![0]).toMatchObject({ toolCallId: "c1", name: "refund", kind: "approval" });
    expect(openPending(stored([], first.messages))).toEqual(first.pending);
  });

  test("a call read back from the stored thread can be answered, and is gone once it is", async () => {
    const refunded: string[] = [];
    const tools = [refundTool(refunded)];
    const first = await turn(
      Agent.create({
        name: "support",
        provider: fakeProvider([toolCall("c1", "refund", { orderId: "o1" }), finish()]),
        tools,
      }),
      [],
      { text: "refund o1" },
    );
    const thread = stored([], first.messages);

    // The reloaded page: no frame, only the thread.
    const [restored] = openPending(thread);
    const second = await turn(
      Agent.create({ name: "support", provider: fakeProvider(say("done")), tools }),
      thread,
      {
        toolResults: [
          { toolCallId: restored.toolCallId, signature: restored.signature, approve: true },
        ],
      },
    );

    expect(refunded).toEqual(["o1"]);
    expect(second.events.find((event) => event.type === "error")).toBeUndefined();
    const after = stored(thread, second.messages);
    expect(openPending(after)).toEqual([]);
    // Taken off the message too, not only filtered out on read.
    expect(after.some((message) => message.pending !== undefined)).toBe(false);
  });

  test("a call a later turn refused is not handed back", async () => {
    const tools = [refundTool([])];
    const first = await turn(
      Agent.create({
        name: "support",
        provider: fakeProvider([toolCall("c1", "refund", { orderId: "o1" }), finish()]),
        tools,
      }),
      [],
      { text: "refund o1" },
    );
    const thread = stored([], first.messages);
    const second = await turn(
      Agent.create({ name: "support", provider: fakeProvider(say("ok, not refunding")), tools }),
      thread,
      { text: "never mind" },
    );

    const after = stored(thread, second.messages);
    expect(openPending(after)).toEqual([]);
    expect(after.some((message) => message.pending !== undefined)).toBe(false);
  });

  test("openPending leaves out a call with a result, even if the message still lists it", () => {
    const pending: PendingToolCall = {
      toolCallId: "c1",
      name: "refund",
      input: { orderId: "o1" },
      kind: "approval",
      signature: "sig",
    };
    const asking: AgentMessage = {
      id: "m1",
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", name: "refund", input: { orderId: "o1" } }],
      createdAt: new Date(0).toISOString(),
      finishReason: "awaiting-input",
      pending: [pending],
    };
    expect(openPending([asking])).toEqual([pending]);
    const answered: AgentMessage = {
      ...asking,
      content: [
        ...asking.content,
        { type: "tool-result", toolCallId: "c1", name: "refund", status: "denied", cause: "interrupted" },
      ],
    };
    expect(openPending([answered])).toEqual([]);
  });

  test("a sub-agent's question asked again replaces the one stored, with the new signature", async () => {
    // The sub-agent asks, is answered, and asks again: the parent's call stays
    // open, and the page must get the second question, not the first.
    const subProvider = fakeProvider(
      [toolCall("s1", "ask", { question: "which region?" }), finish()],
      [toolCall("s2", "ask", { question: "which city?" }), finish()],
      say("filed"),
    );
    const sub = Agent.create({ name: "clerk", provider: subProvider, tools: [ask] });
    const delegate = AgentTool.create({
      name: "delegate",
      description: "Delegate to the clerk",
      inputSchema: s.object({}),
      execute: async (_input: unknown, ctx: any) => {
        const run = await ctx.runAgent(sub, { prompt: "file it" });
        return { finish: run.finishReason };
      },
    });
    const lead = (provider = fakeProvider([toolCall("c1", "delegate", {}), finish()])) =>
      Agent.create({ name: "lead", provider, tools: [delegate] });

    const first = await turn(lead(), [], { text: "go" });
    let thread = stored([], first.messages);
    const [question] = openPending(thread);
    expect(question).toMatchObject({ toolCallId: "s1", path: ["c1"], kind: "question" });

    const second = await turn(lead(fakeProvider(say("done"))), thread, {
      toolResults: [
        {
          toolCallId: question.toolCallId,
          signature: question.signature,
          path: question.path,
          output: { answer: "emea" },
        },
      ],
    });
    expect(second.finishReason).toBe("awaiting-input");
    thread = stored(thread, second.messages);
    const restored = openPending(thread);
    expect(restored).toEqual(second.pending);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ toolCallId: "s2", path: ["c1"] });

    const third = await turn(lead(fakeProvider(say("all done"))), thread, {
      toolResults: [
        {
          toolCallId: restored[0].toolCallId,
          signature: restored[0].signature,
          path: restored[0].path,
          output: { answer: "paris" },
        },
      ],
    });
    expect(third.events.find((event) => event.type === "error")).toBeUndefined();
    expect(openPending(stored(thread, third.messages))).toEqual([]);
  });

  test("a turn of answers to calls that are no longer open does not run the model again", async () => {
    // Two tabs restored the same question; the first answered it. The second
    // tab's answer must not become a second reply to the same history.
    const refunded: string[] = [];
    const tools = [refundTool(refunded)];
    const first = await turn(
      Agent.create({
        name: "support",
        provider: fakeProvider([toolCall("c1", "refund", { orderId: "o1" }), finish()]),
        tools,
      }),
      [],
      { text: "refund o1" },
    );
    let thread = stored([], first.messages);
    const [restored] = openPending(thread);
    const answer: ClientTurn = {
      toolResults: [{ toolCallId: restored.toolCallId, signature: restored.signature, approve: true }],
    };

    const tabA = await turn(
      Agent.create({ name: "support", provider: fakeProvider(say("refunded")), tools }),
      thread,
      answer,
    );
    thread = stored(thread, tabA.messages);

    const late = fakeProvider(say("refunded again"));
    const tabB = await turn(Agent.create({ name: "support", provider: late, tools }), thread, answer);

    expect(refunded).toEqual(["o1"]);
    expect(late.calls).toHaveLength(0);
    expect(tabB.events.find((event) => event.type === "error")).toMatchObject({
      error: { code: "invalid_tool_result" },
    });
    expect(tabB.messages).toEqual([]);
  });
});
