process.env.SECRET ??= "agent-controller-tool-result-input-test-secret";

import { expect, test, vi } from "vitest";

import { Agent, AgentTool } from "./Agent";
import {
  AgentController,
  defineAgentHooks,
  MemoryAgentStore,
  MemoryLiveRuns,
  type ToolResultCall,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { ToolResultPart } from "./types";

/**
 * #1079: `onToolResult` gets the call it answers, input included, for every
 * status: an audit of a refused approval can say what was refused without
 * reading the thread back.
 */

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

function setup(scripts: ProviderEvent[][]) {
  const store = new MemoryAgentStore();
  const seen: { result: ToolResultPart; call: ToolResultCall }[] = [];

  const lookup = AgentTool.create({
    name: "lookup",
    description: "Look a page up",
    inputSchema: s.object({ pageId: s.string() }),
    execute: async ({ pageId }) => ({ found: pageId }),
  });
  const executeWrite = AgentTool.create({
    name: "execute_write",
    description: "Run a write preview",
    inputSchema: s.object({ previewId: s.string() }),
    requiresApproval: true,
    execute: async ({ previewId }) => ({ wrote: previewId }),
  });

  class Chat extends AgentController {
    agent = Agent.create({
      name: "audit-chat",
      provider: fakeProvider(...scripts),
      tools: [lookup, executeWrite],
    }) as any;
    store = store;
    liveRuns = new MemoryLiveRuns();
    hooks = defineAgentHooks({
      onToolResult: (result, _ctx, call) => {
        seen.push({ result, call });
      },
    });
  }

  return { store, seen, Chat };
}

test("an ok result and an input the schema refused both carry the call's input", async () => {
  const { store, seen, Chat } = setup([
    [
      { type: "tool-call", toolCallId: "c1", name: "lookup", args: '{"pageId":"p_1"}' },
      { type: "tool-call", toolCallId: "c2", name: "lookup", args: '{"pageId":7}' },
      finish(),
    ],
    [{ type: "text-delta", delta: "done" }, finish()],
  ]);
  const { threadId } = await store.createThread({});

  await (await Chat.startTurn({ threadId, text: "look" })).result();
  await vi.waitFor(() => expect(seen).toHaveLength(2));

  const byCall = [...seen].sort((a, b) => a.call.toolCallId.localeCompare(b.call.toolCallId));
  expect(byCall.map(({ result, call }) => [result.status, call])).toEqual([
    ["ok", { toolCallId: "c1", name: "lookup", input: { pageId: "p_1" } }],
    ["error", { toolCallId: "c2", name: "lookup", input: { pageId: 7 } }],
  ]);
});

test("a refused approval, answered on a later turn, carries the call's input", async () => {
  const { store, seen, Chat } = setup([
    [
      { type: "tool-call", toolCallId: "w1", name: "execute_write", args: '{"previewId":"pv_42"}' },
      finish(),
    ],
    [{ type: "text-delta", delta: "Not written." }, finish()],
  ]);
  const { threadId } = await store.createThread({ userId: 1 });
  const user = { id: 1 };

  const first = await (await Chat.startTurn({ threadId, text: "write it", user })).result();
  expect(first.finishReason).toBe("awaiting-input");
  expect(seen).toEqual([]);

  await (
    await Chat.startTurn({
      threadId,
      user,
      turn: {
        toolResults: [{ toolCallId: "w1", signature: first.pending[0]!.signature, approve: false }],
      },
    })
  ).result();
  await vi.waitFor(() => expect(seen).toHaveLength(1));

  expect(seen[0]!.result).toMatchObject({ toolCallId: "w1", status: "denied" });
  expect(seen[0]!.call).toEqual({
    toolCallId: "w1",
    name: "execute_write",
    input: { previewId: "pv_42" },
  });
});

test("the input stays off the wire", async () => {
  const { store, Chat } = setup([
    [
      { type: "tool-call", toolCallId: "c1", name: "lookup", args: '{"pageId":"p_1"}' },
      finish(),
    ],
    [{ type: "text-delta", delta: "done" }, finish()],
  ]);
  const { threadId } = await store.createThread({});

  const turn = await Chat.startTurn({ threadId, text: "look" });
  const body = await turn.run.toResponse().text();
  const result = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "tool-result");
  expect(result).toEqual({
    type: "tool-result",
    messageId: expect.any(String),
    part: expect.not.objectContaining({ input: expect.anything() }),
  });
});
