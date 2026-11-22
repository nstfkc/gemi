process.env.SECRET ??= "agent-sibling-questions-test-secret";

import { describe, expect, test } from "vitest";

import { Agent, AgentTool } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { toResponsesInput, WAITING_ON_USER } from "./providers/request";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, PendingToolCall, ToolResultPart } from "./types";

// One reply that asks two questions (#1380): answering one carries the turn
// on and leaves the other open, with its `pending`, until it is answered.

const finish = (reason: "stop" | "tool-calls" = "stop"): ProviderEvent => ({
  type: "finish",
  reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];
const asks = (...ids: string[]): ProviderEvent[] => [
  ...ids.map((id, i) => ({
    type: "tool-call" as const,
    toolCallId: id,
    name: "publish",
    args: `{"page":${i + 1}}`,
  })),
  finish("tool-calls"),
];

const published: number[] = [];
const publish = AgentTool.create({
  name: "publish",
  description: "Publish a page",
  inputSchema: s.object({ page: s.number() }),
  requiresApproval: true,
  execute: async ({ page }: { page: number }) => {
    published.push(page);
    return { published: page };
  },
});

async function drain(stream: ReturnType<Agent<any>["stream"]>) {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events };
}

/** The thread after a run: its messages upserted by id, as a store keeps them. */
function upsert(history: AgentMessage[], produced: AgentMessage[]): AgentMessage[] {
  const next = [...history];
  for (const message of produced) {
    const at = next.findIndex((other) => other.id === message.id);
    if (at >= 0) next[at] = message;
    else next.push(message);
  }
  return next;
}

const awaiting = (events: AgentStreamEvent[]) =>
  (
    events.find((event) => event.type === "awaiting-input") as
      | { pending: PendingToolCall[] }
      | undefined
  )?.pending;
const resultOf = (messages: AgentMessage[], id: string) =>
  messages
    .flatMap((message) => message.content)
    .find((part): part is ToolResultPart => part.type === "tool-result" && part.toolCallId === id);
const pendingIds = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.pending ?? []).map((call) => call.toolCallId);

async function askTwo(...scripts: ProviderEvent[][]) {
  published.length = 0;
  const provider = fakeProvider(asks("q1", "q2"), ...scripts);
  const agent = Agent.create({ name: "pages", provider, tools: [publish] });
  const first = await drain(agent.stream({ messages: [], turn: { text: "publish both pages" } }));
  const asked = awaiting(first.events)!;
  expect(asked.map((call) => call.toolCallId)).toEqual(["q1", "q2"]);
  const turn = first.result.messages[0]!.id;
  const sig = (id: string) => asked.find((call) => call.toolCallId === id)!.signature;
  return { agent, provider, history: first.result.messages as AgentMessage[], turn, sig };
}

describe("a reply's questions are answered one at a time (#1380)", () => {
  test("answering one carries the turn on and leaves the other open; answering it finishes the turn", async () => {
    const { agent, provider, history, turn, sig } = await askTwo(
      say("Page 1 is up."),
      say("Both are up."),
    );

    const second = agent.stream({
      messages: history,
      turn: { toolResults: [{ toolCallId: "q1", signature: sig("q1"), approve: true }] },
    });
    const one = await drain(second);
    expect(second.turn).toEqual({ id: turn, continues: true, answers: ["q1"] });
    expect(one.result.finishReason).toBe("stop");
    const afterOne = upsert(history, one.result.messages as AgentMessage[]);
    expect(resultOf(afterOne, "q1")).toMatchObject({ status: "ok" });
    // Still open: no result, and still asked on its message, with its turn.
    expect(resultOf(afterOne, "q2")).toBeUndefined();
    expect(pendingIds(afterOne)).toEqual(["q2"]);
    expect(afterOne.flatMap((message) => message.pending ?? [])[0]).toMatchObject({
      turn,
      signature: sig("q2"),
    });
    expect(published).toEqual([1]);

    // The model read the open one as waiting on the user, not as lost.
    const input = toResponsesInput(provider.calls[1]!.messages, {
      reasoning: false,
      structuredOutput: true,
      fileInput: true,
      parallelToolCalls: true,
      toolSearch: false,
    });
    expect(
      input.find((item) => item.type === "function_call_output" && item.call_id === "q2")!.output,
    ).toBe(WAITING_ON_USER);

    const third = agent.stream({
      messages: afterOne,
      turn: { toolResults: [{ toolCallId: "q2", signature: sig("q2"), approve: true }] },
    });
    const two = await drain(third);
    expect(third.turn).toEqual({ id: turn, continues: true, answers: ["q2"] });
    const afterTwo = upsert(afterOne, two.result.messages as AgentMessage[]);
    expect(resultOf(afterTwo, "q2")).toMatchObject({ status: "ok" });
    expect(pendingIds(afterTwo)).toEqual([]);
    expect(published).toEqual([1, 2]);
    expect(afterTwo.every((message) => message.turn === turn)).toBe(true);
  });

  test("in the other order, and a refusal is an answer too", async () => {
    const { agent, history, sig } = await askTwo(say("Skipped page 2."), say("Page 1 is up."));

    const one = await drain(
      agent.stream({
        messages: history,
        turn: { toolResults: [{ toolCallId: "q2", signature: sig("q2"), approve: false }] },
      }),
    );
    const afterOne = upsert(history, one.result.messages as AgentMessage[]);
    expect(resultOf(afterOne, "q2")).toMatchObject({ status: "denied" });
    expect(resultOf(afterOne, "q1")).toBeUndefined();
    expect(pendingIds(afterOne)).toEqual(["q1"]);

    const two = await drain(
      agent.stream({
        messages: afterOne,
        turn: { toolResults: [{ toolCallId: "q1", signature: sig("q1"), approve: true }] },
      }),
    );
    const afterTwo = upsert(afterOne, two.result.messages as AgentMessage[]);
    expect(resultOf(afterTwo, "q1")).toMatchObject({ status: "ok" });
    expect(pendingIds(afterTwo)).toEqual([]);
    expect(published).toEqual([1]);
  });

  test("both answered in one request settle together, as before", async () => {
    const { agent, history, sig } = await askTwo(say("Both are up."));
    const both = await drain(
      agent.stream({
        messages: history,
        turn: {
          toolResults: [
            { toolCallId: "q1", signature: sig("q1"), approve: true },
            { toolCallId: "q2", signature: sig("q2"), approve: true },
          ],
        },
      }),
    );
    const after = upsert(history, both.result.messages as AgentMessage[]);
    expect(pendingIds(after)).toEqual([]);
    expect(published).toEqual([1, 2]);
  });

  test("a new question after the first answer: the frame lists both open ones, each message keeps its own", async () => {
    const { agent, history, turn, sig } = await askTwo(asks("q3"));
    const stream = agent.stream({
      messages: history,
      turn: { toolResults: [{ toolCallId: "q1", signature: sig("q1"), approve: true }] },
    });
    const { result, events } = await drain(stream);
    expect(result.finishReason).toBe("awaiting-input");
    expect(awaiting(events)!.map((call) => [call.toolCallId, call.turn])).toEqual([
      ["q2", turn],
      ["q3", turn],
    ]);
    const after = upsert(history, result.messages as AgentMessage[]);
    expect(after.map((message) => (message.pending ?? []).map((call) => call.toolCallId))).toEqual([
      [],
      ["q2"],
      ["q3"],
    ]);
  });

  test("a call answered with a bad signature is refused; its sibling stays open", async () => {
    const { agent, history, sig } = await askTwo(say("Could not publish page 1."));
    const { result } = await drain(
      agent.stream({
        messages: history,
        turn: { toolResults: [{ toolCallId: "q1", signature: `${sig("q1")}x`, approve: true }] },
      }),
    );
    const after = upsert(history, result.messages as AgentMessage[]);
    expect(resultOf(after, "q1")).toMatchObject({ status: "denied", cause: "refused" });
    expect(resultOf(after, "q2")).toBeUndefined();
    expect(pendingIds(after)).toEqual(["q2"]);
  });

  test("a stop during the reply the first answer carries on leaves the other question open", async () => {
    const { agent, history, sig } = await askTwo([{ type: "text-delta", delta: "Working" }]);
    const stream = agent.stream({
      messages: history,
      turn: { toolResults: [{ toolCallId: "q1", signature: sig("q1"), approve: true }] },
    });
    const events: AgentStreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "text-delta") stream.stop();
    }
    const result = await stream.result();
    const after = upsert(history, result.messages as AgentMessage[]);
    expect(resultOf(after, "q1")).toMatchObject({ status: "ok" });
    expect(resultOf(after, "q2")).toBeUndefined();
    expect(pendingIds(after)).toEqual(["q2"]);
  });

  test("a new message still refuses the open questions, as a person who moves on does", async () => {
    const { agent, history } = await askTwo(say("Sure."));
    const { result } = await drain(
      agent.stream({ messages: history, turn: { text: "never mind" } }),
    );
    const after = upsert(history, result.messages as AgentMessage[]);
    expect(resultOf(after, "q1")).toMatchObject({ status: "denied", cause: "refused" });
    expect(resultOf(after, "q2")).toMatchObject({ status: "denied", cause: "refused" });
    expect(pendingIds(after)).toEqual([]);
  });
});
