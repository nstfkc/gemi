process.env.SECRET ??= "agent-test-secret";

import { afterEach, describe, expect, test, vi } from "vitest";
import { Agent, AgentTool, type ToolApprovalContext, type ToolContext } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { openPending } from "./client/reducer";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import { MemoryReceiptStore } from "./store/Receipts";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "./types";

// Approval previews (#1060) and who approved a call (#1062).

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

const results = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

function writeTool(
  options: {
    requiresApproval?: any;
    approvalPreview?: any;
    seen?: ToolContext[];
  } = {},
) {
  return AgentTool.create({
    name: "write",
    description: "Run a write",
    inputSchema: s.object({ sql: s.string() }),
    requiresApproval: options.requiresApproval ?? true,
    approvalPreview:
      "approvalPreview" in options
        ? options.approvalPreview
        : async (input: { sql: string }) => ({ sql: input.sql, affectedRows: 3 }),
    execute: async (input: { sql: string }, ctx) => {
      options.seen?.push(ctx);
      return { ran: input.sql };
    },
  });
}

async function ask(tool: AgentTool<string, any, any, any>, params: { subject?: string | null } = {}) {
  const provider = fakeProvider([toolCall("c1", tool.name, { sql: "update t set a = 1" }), finish()]);
  const stream = Agent.create({ name: "dba", provider, tools: [tool] }).stream({
    messages: [],
    turn: { text: "fix it" },
    ...params,
  });
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  const awaiting = events.find((event) => event.type === "awaiting-input") as any;
  return { result, pending: (awaiting?.pending ?? []) as PendingToolCall[] };
}

async function answer(
  tool: AgentTool<string, any, any, any>,
  first: { result: { messages: AgentMessage[] }; pending: PendingToolCall[] },
  approve: boolean,
  params: { subject?: string | null; reason?: string; receipts?: MemoryReceiptStore } = {},
) {
  const stream = Agent.create({
    name: "dba",
    provider: fakeProvider([{ type: "text-delta", delta: "done" }, finish()]),
    tools: [tool],
  }).stream({
    messages: first.result.messages,
    subject: params.subject,
    receipts: params.receipts,
    turn: {
      toolResults: [
        {
          toolCallId: "c1",
          signature: first.pending[0]!.signature,
          approve,
          ...(params.reason ? { reason: params.reason } : {}),
        },
      ],
    },
  });
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events };
}

afterEach(() => vi.restoreAllMocks());

describe("approvalPreview (#1060)", () => {
  test("the preview is on the pending call, the frame and the stored message", async () => {
    const seen: { input: unknown; ctx: ToolApprovalContext }[] = [];
    const tool = writeTool({
      approvalPreview: (input: unknown, ctx: ToolApprovalContext) => {
        seen.push({ input, ctx });
        return { sql: (input as any).sql, affectedRows: 3, at: new Date(0) };
      },
    });

    const { result, pending } = await ask(tool);

    expect(result.finishReason).toBe("awaiting-input");
    // JSON, as it is stored and sent: the Date became its string.
    const preview = { sql: "update t set a = 1", affectedRows: 3, at: "1970-01-01T00:00:00.000Z" };
    expect(pending[0]).toMatchObject({ toolCallId: "c1", kind: "approval", preview });
    const stored = result.messages.find((message) => message.pending)!;
    expect(stored.pending![0]).toMatchObject({ preview });
    // What a reloaded page restores.
    expect(openPending(result.messages)[0]).toMatchObject({ preview });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.input).toEqual({ sql: "update t set a = 1" });
    expect(seen[0]!.ctx).toMatchObject({ toolCallId: "c1", step: 1, depth: 0 });
  });

  test("an approval answered against a call with a preview still verifies", async () => {
    const tool = writeTool();
    const first = await ask(tool);

    const { result } = await answer(tool, first, true);

    expect(results(result.messages)[0]).toMatchObject({ status: "ok", output: { ran: "update t set a = 1" } });
  });

  test("not called for a call that runs without asking", async () => {
    const preview = vi.fn(() => ({ x: 1 }));
    const tool = writeTool({ requiresApproval: () => false, approvalPreview: preview });
    const provider = fakeProvider(
      [toolCall("c1", "write", { sql: "select 1" }), finish()],
      [{ type: "text-delta", delta: "ok" }, finish()],
    );
    const result = await Agent.create({ name: "dba", provider, tools: [tool] })
      .stream({ messages: [], turn: { text: "go" } })
      .result();

    expect(preview).not.toHaveBeenCalled();
    expect(results(result.messages)[0]).toMatchObject({ status: "ok" });
  });

  test("a preview that throws is logged, and the call is asked without one", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const tool = writeTool({
      approvalPreview: () => {
        throw new Error("dry run failed");
      },
    });

    const { pending } = await ask(tool);

    expect(pending).toHaveLength(1);
    expect(pending[0]).not.toHaveProperty("preview");
    expect(logged.mock.calls.flat().join(" ")).toContain("approvalPreview");
  });

  test("a preview past the tool's timeoutMs is left off, and the call is still asked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tool = AgentTool.create({
      name: "write",
      description: "Run a write",
      inputSchema: s.object({ sql: s.string() }),
      requiresApproval: true,
      timeoutMs: 20,
      approvalPreview: () => new Promise(() => {}),
      execute: async () => ({}),
    });
    const { pending } = await ask(tool);
    expect(pending).toHaveLength(1);
    expect(pending[0]).not.toHaveProperty("preview");
  });

  test("undefined is no preview", async () => {
    const { pending } = await ask(writeTool({ approvalPreview: () => undefined }));
    expect(pending[0]).not.toHaveProperty("preview");
  });

  test("a tool without one has no preview field", async () => {
    const { pending } = await ask(writeTool({ approvalPreview: undefined }));
    expect(pending[0]).not.toHaveProperty("preview");
  });

  test("refused when the tool never asks, or is not a function", () => {
    expect(() => writeTool({ requiresApproval: false })).toThrow(/no requiresApproval/);
    expect(() => writeTool({ approvalPreview: "yes" })).toThrow(/not a function/);
  });
});

describe("who approved a call (#1062)", () => {
  test("ctx.approval and the result carry who approved it and when", async () => {
    const seen: ToolContext[] = [];
    const tool = writeTool({ seen });
    const first = await ask(tool, { subject: "user:7" });

    const before = Date.now();
    const { result, events } = await answer(tool, first, true, {
      subject: "user:7",
      reason: "checked the sample",
    });

    const approval = { approved: true, by: "user:7", reason: "checked the sample" };
    expect(seen[0]!.approval).toMatchObject(approval);
    expect(Date.parse(seen[0]!.approval!.at)).toBeGreaterThanOrEqual(before - 1000);
    const part = results(result.messages)[0];
    expect(part).toMatchObject({ status: "ok", approval });
    expect(part.approval.at).toBe(seen[0]!.approval!.at);
    const frame = events.find((event) => event.type === "tool-result") as any;
    expect(frame.part.approval).toMatchObject(approval);
  });

  test("a refusal carries the record too", async () => {
    const seen: ToolContext[] = [];
    const tool = writeTool({ seen });
    const first = await ask(tool);

    const { result } = await answer(tool, first, false, { reason: "too many rows" });

    expect(seen).toEqual([]);
    expect(results(result.messages)[0]).toMatchObject({
      status: "denied",
      cause: "refused",
      reason: "too many rows",
      approval: { approved: false, by: null, reason: "too many rows" },
    });
  });

  test("a call that never asked has no ctx.approval and no record", async () => {
    const seen: ToolContext[] = [];
    const tool = writeTool({ requiresApproval: () => false, seen });
    const result = await Agent.create({
      name: "dba",
      provider: fakeProvider(
        [toolCall("c1", "write", { sql: "select 1" }), finish()],
        [{ type: "text-delta", delta: "ok" }, finish()],
      ),
      tools: [tool],
    })
      .stream({ messages: [], turn: { text: "go" } })
      .result();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.approval).toBeUndefined();
    expect(results(result.messages)[0]).not.toHaveProperty("approval");
  });

  test("a replayed approval answers with the record of the one that ran", async () => {
    const seen: ToolContext[] = [];
    const tool = writeTool({ seen });
    const receipts = new MemoryReceiptStore();
    const first = await ask(tool);

    const once = await answer(tool, first, true, { receipts });
    const again = await answer(tool, first, true, { receipts });

    expect(seen).toHaveLength(1);
    expect(results(again.result.messages)[0].approval).toEqual(
      results(once.result.messages)[0].approval,
    );
  });
});
