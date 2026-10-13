process.env.SECRET ??= "agent-test-secret";

import { afterEach, describe, expect, test, vi } from "vitest";
import { Agent, AgentTool, type ToolApprovalContext } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "./types";

// `requiresApproval` decided per call (#944).

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

async function run(
  tool: AgentTool<string, any, any, any>,
  params: { context?: any; body?: Record<string, unknown> } = {},
) {
  const provider = fakeProvider(
    [toolCall("c1", tool.name, { count: 2 }), finish()],
    [{ type: "text-delta", delta: "drawn" }, finish()],
  );
  const agent = Agent.create({ name: "artist", provider, tools: [tool] });
  const stream = agent.stream({ messages: [], turn: { text: "draw" }, ...params });
  const events: AgentStreamEvent[] = [];
  const done = (async () => {
    for await (const event of stream) events.push(event);
  })();
  const result = await stream.result();
  await done;
  const awaiting = events.find((event) => event.type === "awaiting-input") as any;
  return { result, provider, pending: (awaiting?.pending ?? []) as PendingToolCall[], tool };
}

function drawTool(requiresApproval: any, calls: unknown[] = []) {
  return AgentTool.create({
    name: "draw",
    description: "Draw pictures",
    inputSchema: s.object({ count: s.number() }),
    requiresApproval,
    execute: async (input: { count: number }) => {
      calls.push(input);
      return { drawn: input.count };
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("requiresApproval as a function (#944)", () => {
  test("answering false runs the tool in the same run, with nothing pending", async () => {
    const calls: unknown[] = [];
    const seen: { input: unknown; ctx: ToolApprovalContext }[] = [];
    const tool = drawTool((input: unknown, ctx: ToolApprovalContext) => {
      seen.push({ input, ctx });
      return (ctx.context as any).alwaysAllow !== true;
    }, calls);

    const { result, pending, provider } = await run(tool, {
      context: { alwaysAllow: true },
      body: { pageId: "p_1" },
    });

    expect(pending).toEqual([]);
    expect(calls).toEqual([{ count: 2 }]);
    expect(result.finishReason).toBe("stop");
    expect(results(result.messages)[0]).toMatchObject({ toolCallId: "c1", status: "ok", output: { drawn: 2 } });
    expect(provider.calls).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].input).toEqual({ count: 2 });
    expect(seen[0].ctx).toMatchObject({
      context: { alwaysAllow: true },
      body: { pageId: "p_1" },
      toolCallId: "c1",
      step: 1,
      depth: 0,
    });
    expect(typeof seen[0].ctx.runId).toBe("string");
    expect(seen[0].ctx.signal).toBeInstanceOf(AbortSignal);
  });

  test("answering true pends the call, signed, like requiresApproval: true", async () => {
    const calls: unknown[] = [];
    const tool = drawTool(async () => true, calls);

    const { result, pending } = await run(tool);

    expect(calls).toEqual([]);
    expect(result.finishReason).toBe("awaiting-input");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolCallId: "c1", name: "draw", kind: "approval" });
    expect(pending[0].signature).toBeTruthy();
  });

  test("an approval answered later stands, even if the function now says it needs none", async () => {
    let ask = true;
    const calls: unknown[] = [];
    const predicate = vi.fn(() => ask);
    const tool = drawTool(predicate, calls);
    const first = await run(tool);
    expect(first.pending).toHaveLength(1);

    ask = false;
    const second = await Agent.create({
      name: "artist",
      provider: fakeProvider([{ type: "text-delta", delta: "drawn" }, finish()]),
      tools: [tool],
    })
      .stream({
        messages: first.result.messages,
        turn: {
          toolResults: [{ toolCallId: "c1", signature: first.pending[0].signature, approve: true }],
        },
      })
      .result();

    expect(calls).toEqual([{ count: 2 }]);
    expect(results(second.messages)[0]).toMatchObject({ status: "ok", output: { drawn: 2 } });
    // Called once, for the first run; the answer is verified, not re-decided.
    expect(predicate).toHaveBeenCalledTimes(1);
  });

  test("a refusal of a call the function asked about is still a refusal", async () => {
    const calls: unknown[] = [];
    const tool = drawTool(() => true, calls);
    const first = await run(tool);

    const second = await Agent.create({
      name: "artist",
      provider: fakeProvider([{ type: "text-delta", delta: "ok" }, finish()]),
      tools: [tool],
    })
      .stream({
        messages: first.result.messages,
        turn: {
          toolResults: [{ toolCallId: "c1", signature: first.pending[0].signature, approve: false }],
        },
      })
      .result();

    expect(calls).toEqual([]);
    expect(results(second.messages)[0]).toMatchObject({ status: "denied", cause: "refused" });
  });

  test("a function that throws fails closed: the call asks, and the error is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: unknown[] = [];
    const tool = drawTool(async () => {
      throw new Error("settings store down");
    }, calls);

    const { result, pending } = await run(tool);

    expect(calls).toEqual([]);
    expect(result.finishReason).toBe("awaiting-input");
    expect(pending[0]).toMatchObject({ kind: "approval" });
    expect(logged.mock.calls.flat().join(" ")).toContain("requiresApproval");
  });

  test("only false skips the question: a function answering undefined asks", async () => {
    const calls: unknown[] = [];
    const tool = drawTool(() => undefined, calls);

    const { pending } = await run(tool);

    expect(calls).toEqual([]);
    expect(pending).toHaveLength(1);
  });

  test("decides each call of a step on its own input", async () => {
    const calls: any[] = [];
    const tool = drawTool((input: { count: number }) => input.count > 3, calls);
    const provider = fakeProvider(
      [toolCall("c1", "draw", { count: 1 }), toolCall("c2", "draw", { count: 8 }), finish()],
    );
    const stream = Agent.create({ name: "artist", provider, tools: [tool] }).stream({
      messages: [],
      turn: { text: "draw" },
    });
    const events: AgentStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(calls).toEqual([{ count: 1 }]);
    const pending = (events.find((event) => event.type === "awaiting-input") as any).pending;
    expect(pending.map((call: PendingToolCall) => call.toolCallId)).toEqual(["c2"]);
    expect(results(result.messages).map((part) => part.toolCallId)).toEqual(["c1"]);
  });

  test("is not called with input that failed validation", async () => {
    const predicate = vi.fn(() => false);
    const tool = drawTool(predicate);
    const provider = fakeProvider(
      [toolCall("c1", "draw", { count: "two" }), finish()],
      [{ type: "text-delta", delta: "sorry" }, finish()],
    );
    const result = await Agent.create({ name: "artist", provider, tools: [tool] })
      .stream({ messages: [], turn: { text: "draw" } })
      .result();

    expect(predicate).not.toHaveBeenCalled();
    expect(results(result.messages)[0]).toMatchObject({ status: "error" });
  });

  test("a sub-agent's tool answering false runs inside the sub-run, without escalating", async () => {
    const calls: unknown[] = [];
    const tool = drawTool(() => false, calls);
    const sub = Agent.create({
      name: "painter",
      provider: fakeProvider(
        [toolCall("s1", "draw", { count: 3 }), finish()],
        [{ type: "text-delta", delta: "painted" }, finish()],
      ),
      tools: [tool],
    });
    const delegate = AgentTool.create({
      name: "delegate",
      description: "Ask the painter",
      inputSchema: s.object({}),
      execute: async (_input, ctx) => {
        const nested = await ctx.runAgent(sub, { prompt: "paint" });
        return { finish: nested.finishReason };
      },
    });
    const result = await Agent.create({
      name: "lead",
      provider: fakeProvider(
        [toolCall("c1", "delegate", {}), finish()],
        [{ type: "text-delta", delta: "done" }, finish()],
      ),
      tools: [delegate],
    })
      .stream({ messages: [], turn: { text: "go" } })
      .result();

    expect(calls).toEqual([{ count: 3 }]);
    expect(result.finishReason).toBe("stop");
    expect(results(result.messages)[0]).toMatchObject({ status: "ok", output: { finish: "stop" } });
  });

  test("stop() is not held up by a function that never settles", async () => {
    const tool = drawTool(() => new Promise<boolean>(() => {}));
    const stream = Agent.create({
      name: "artist",
      provider: fakeProvider([toolCall("c1", "draw", { count: 1 }), finish()]),
      tools: [tool],
    }).stream({ messages: [], turn: { text: "draw" } });
    const iterator = stream[Symbol.asyncIterator]();
    // Let the run reach the tool call before stopping it.
    for (;;) {
      const next = await iterator.next();
      if (next.done || next.value.type === "tool-call") break;
    }
    setTimeout(() => stream.stop(), 5);
    const result = await stream.result();
    expect(result.finishReason).toBe("aborted");
  });

  test("the boolean forms are unchanged, and the tool reads as one that may ask", () => {
    expect(drawTool(true).requiresApproval).toBe(true);
    expect(drawTool(true).approvalPredicate).toBeUndefined();
    expect(drawTool(false).requiresApproval).toBe(false);
    expect(drawTool(undefined).requiresApproval).toBe(false);
    const predicate = () => false;
    expect(drawTool(predicate).requiresApproval).toBe(true);
    expect(drawTool(predicate).approvalPredicate).toBe(predicate);
  });

  test("anything else is refused when the tool is created", () => {
    expect(() => drawTool("yes")).toThrow(/neither a boolean nor a function/);
  });
});
