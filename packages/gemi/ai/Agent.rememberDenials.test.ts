process.env.SECRET ??= "agent-remember-denials-test-secret";

import { expect, test, vi } from "vitest";
import { Agent, type AgentRun, AgentTool } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  defineAgentHooks,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { toolResultOutput } from "./providers/request";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "./types";

// #1260: a denied approval is remembered for the rest of the run.

const toolCall = (toolCallId: string, args: unknown): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name: "publish",
  args: JSON.stringify(args),
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const results = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

function publishTool(rememberDenials?: boolean | "name", calls: unknown[] = []) {
  return AgentTool.create({
    name: "publish",
    description: "Publish a page",
    inputSchema: s.object({ pageId: s.string(), notify: s.boolean().optional() }),
    requiresApproval: true,
    ...(rememberDenials !== undefined ? { rememberDenials } : {}),
    execute: async (input: { pageId: string }) => {
      calls.push(input);
      return { published: input.pageId };
    },
  });
}

/**
 * Turn one asks to publish p_1 and is denied; turn two (the answer) has the
 * model ask again with `again`.
 */
async function deniedThenAskedAgain(
  tool: AgentTool<string, any, any, any>,
  again: unknown,
  agent: { rememberDenials?: boolean | "name" } = {},
) {
  const asked = await collect(
    Agent.create({
      name: "publisher",
      provider: fakeProvider([toolCall("c1", { pageId: "p_1" }), finish()]),
      tools: [tool],
      ...agent,
    }).stream({ messages: [], turn: { text: "publish p_1" } }),
  );
  const first = { ...asked.result, pending: asked.pending };
  expect(first.finishReason).toBe("awaiting-input");

  const provider = fakeProvider(
    [toolCall("c2", again), finish()],
    [{ type: "text-delta", delta: "left as it is" }, finish()],
  );
  const stream = Agent.create({ name: "publisher", provider, tools: [tool], ...agent }).stream({
    messages: first.messages,
    turn: {
      toolResults: [
        { toolCallId: "c1", signature: first.pending[0]!.signature, approve: false, reason: "not yet" },
      ],
    },
  });
  const { result, pending } = await collect(stream);
  return {
    result,
    provider,
    stream,
    pending,
    second: results(result.messages).find((part) => part.toolCallId === "c2"),
  };
}

async function collect(stream: AgentRun) {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  const awaiting = events.find((event) => event.type === "awaiting-input") as any;
  return { result, pending: (awaiting?.pending ?? []) as PendingToolCall[] };
}

test("the same call asked again in the run is denied at once, without a new approval", async () => {
  const calls: unknown[] = [];
  const { result, pending, second, provider } = await deniedThenAskedAgain(
    publishTool(undefined, calls),
    { pageId: "p_1" },
    { rememberDenials: true },
  );

  expect(pending).toEqual([]);
  expect(calls).toEqual([]);
  expect(result.finishReason).toBe("stop");
  expect(provider.calls).toHaveLength(2);
  expect(second).toMatchObject({
    toolCallId: "c2",
    name: "publish",
    status: "denied",
    cause: "denied-earlier",
    reason: "not yet",
  });
  expect(second.approval).toBeUndefined();
  expect(toolResultOutput(second)).toContain("already declined");
});

test("matches on the parsed input, whatever the key order", async () => {
  const { pending, second } = await deniedThenAskedAgain(
    publishTool(),
    { notify: undefined, pageId: "p_1" },
    { rememberDenials: true },
  );
  expect(pending).toEqual([]);
  expect(second).toMatchObject({ status: "denied", cause: "denied-earlier" });
});

test("a call with other input still asks", async () => {
  const { result, pending } = await deniedThenAskedAgain(
    publishTool(),
    { pageId: "p_2" },
    { rememberDenials: true },
  );
  expect(result.finishReason).toBe("awaiting-input");
  expect(pending.map((call) => call.toolCallId)).toEqual(["c2"]);
});

test('"name" denies every later call of the tool', async () => {
  const { pending, second } = await deniedThenAskedAgain(publishTool("name"), { pageId: "p_2" });
  expect(pending).toEqual([]);
  expect(second).toMatchObject({ status: "denied", cause: "denied-earlier", reason: "not yet" });
});

test("off by default: the call asks again", async () => {
  const { result, pending } = await deniedThenAskedAgain(publishTool(), { pageId: "p_1" });
  expect(result.finishReason).toBe("awaiting-input");
  expect(pending.map((call) => call.toolCallId)).toEqual(["c2"]);
});

test("the tool's setting wins over the agent's", async () => {
  const { pending } = await deniedThenAskedAgain(
    publishTool(false),
    { pageId: "p_1" },
    { rememberDenials: true },
  );
  expect(pending.map((call) => call.toolCallId)).toEqual(["c2"]);
});

test("the run lists its denials, whether or not they are remembered", async () => {
  const { stream } = await deniedThenAskedAgain(publishTool(), { pageId: "p_1" });
  expect(stream.denials).toEqual([
    {
      toolCallId: "c1",
      name: "publish",
      input: { pageId: "p_1" },
      approval: expect.objectContaining({ approved: false, reason: "not yet" }),
    },
  ]);
});

test("rejects a rememberDenials that is not a boolean or \"name\"", () => {
  expect(() => publishTool("input" as any)).toThrow(/rememberDenials/);
  expect(() =>
    Agent.create({
      name: "publisher",
      provider: fakeProvider(),
      rememberDenials: "input" as any,
    }),
  ).toThrow(/rememberDenials/);
});

test("hooks read the run's denials from their context", async () => {
  const store = new MemoryAgentStore();
  const seen: unknown[][] = [];
  const tool = publishTool();
  class Chat extends AgentController {
    agent = Agent.create({
      name: "publisher",
      provider: fakeProvider(
        [toolCall("c1", { pageId: "p_1" }), finish()],
        [{ type: "text-delta", delta: "ok" }, finish()],
      ),
      tools: [tool],
      rememberDenials: true,
    }) as any;
    store = store;
    liveRuns = new MemoryLiveRuns();
    hooks = defineAgentHooks({
      onStreamComplete: (_result, ctx: AgentHookContext) => {
        seen.push([...ctx.denials]);
      },
    });
  }
  const { threadId } = await store.createThread({ userId: 1 });
  const user = { id: 1 };
  const first = await (await Chat.startTurn({ threadId, text: "publish", user })).result();
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toEqual([]);

  await (
    await Chat.startTurn({
      threadId,
      user,
      turn: {
        toolResults: [{ toolCallId: "c1", signature: first.pending[0]!.signature, approve: false }],
      },
    })
  ).result();
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen[1]).toEqual([
    expect.objectContaining({ toolCallId: "c1", name: "publish", input: { pageId: "p_1" } }),
  ]);
});
