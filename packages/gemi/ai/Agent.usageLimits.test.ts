process.env.SECRET ??= "agent-usage-limits-test-secret";

import { describe, expect, test, vi } from "vitest";
import { Agent, AgentTool } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent } from "./types";
import { MemoryUsageLimitStore, type UsageReport } from "./usageLimits";

/** #1124: budgets on what a run, and a key the app chooses, may spend. */

const toolCall = (toolCallId: string, name = "work"): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: "{}",
});

const finish = (tokens = 10): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens },
});

const text = (delta: string): ProviderEvent => ({ type: "text-delta", delta });

const results = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

function setup(...scripts: ProviderEvent[][]) {
  const calls: string[] = [];
  const work = AgentTool.create({
    name: "work",
    description: "Work",
    inputSchema: s.object({}),
    execute: async () => {
      calls.push("work");
      return "done";
    },
  });
  const provider = fakeProvider(...scripts);
  const agent = Agent.create({ name: "worker", provider, tools: [work], maxSteps: 20 });
  return { agent, provider, calls };
}

async function errorFrame(run: ReturnType<ReturnType<typeof setup>["agent"]["stream"]>) {
  const events: AgentStreamEvent[] = [];
  for await (const event of run) events.push(event);
  return events.find((event) => event.type === "error") as any;
}

describe("run limits", () => {
  test("steps: the run stops before the model call that would pass the limit", async () => {
    const { agent, provider } = setup(
      [toolCall("c1"), finish()],
      [toolCall("c2"), finish()],
      [toolCall("c3"), finish()],
    );
    const run = agent.stream({ messages: [], usageLimits: { run: { steps: 2 } } });
    const frame = await errorFrame(run);
    const result = await run.result();

    expect(provider.calls).toHaveLength(2);
    expect(result.finishReason).toBe("error");
    expect(result.error).toMatchObject({
      code: "usage_limit",
      retryable: false,
      usageLimit: { scope: "run", metric: "steps", limit: 2, used: 2 },
    });
    expect(frame.error).toEqual({
      code: "usage_limit",
      message: "The run reached its usage limit of 2 model calls and was stopped.",
      retryable: false,
    });
    // Both steps' tools ran; the transcript is whole.
    expect(results(result.messages)).toHaveLength(2);
  });

  test("tokens: stops once the run has reached the limit, its usage counted", async () => {
    const { agent, provider } = setup(
      [toolCall("c1"), finish(60)],
      [toolCall("c2"), finish(60)],
      [text("never"), finish(60)],
    );
    const result = await agent
      .stream({ messages: [], usageLimits: { run: { tokens: 100 } } })
      .result();
    expect(provider.calls).toHaveLength(2);
    expect(result.usage.totalTokens).toBe(120);
    expect(result.error).toMatchObject({
      code: "usage_limit",
      usageLimit: { scope: "run", metric: "tokens", limit: 100, used: 120 },
    });
  });

  test("toolCalls: a call over the limit is refused with usage_limit and the run ends", async () => {
    const { agent, provider, calls } = setup(
      [toolCall("c1"), toolCall("c2"), toolCall("c3"), finish()],
      [text("never"), finish()],
    );
    const result = await agent
      .stream({ messages: [], usageLimits: { run: { toolCalls: 2 } } })
      .result();
    expect(calls).toEqual(["work", "work"]);
    expect(provider.calls).toHaveLength(1);
    const byCall = Object.fromEntries(results(result.messages).map((part) => [part.toolCallId, part]));
    expect([byCall.c1.status, byCall.c2.status, byCall.c3.status]).toEqual(["ok", "ok", "error"]);
    expect(byCall.c3.error).toMatchObject({
      code: "usage_limit",
      toolCallId: "c3",
      retryable: false,
    });
    expect(result.error).toMatchObject({
      code: "usage_limit",
      usageLimit: { scope: "run", metric: "toolCalls", limit: 2 },
    });
  });

  test("a run under its limits finishes as usual", async () => {
    const { agent } = setup([toolCall("c1"), finish()], [text("ok"), finish()]);
    const result = await agent
      .stream({ messages: [], usageLimits: { run: { steps: 5, tokens: 1000, toolCalls: 5 } } })
      .result();
    expect(result.finishReason).toBe("stop");
    expect(result.error).toBeUndefined();
  });

  test("a limit that isn't a whole number throws from stream", () => {
    const { agent } = setup();
    expect(() => agent.stream({ messages: [], usageLimits: { run: { tokens: -1 } } })).toThrow(
      /usageLimits\.run\.tokens/,
    );
    expect(() =>
      agent.stream({ messages: [], usageLimits: { scopes: [{ key: "", limit: {} }] } }),
    ).toThrow(/no key/);
  });
});

describe("scope limits", () => {
  test("are shared by the runs of one key, and kept apart from other keys", async () => {
    const store = new MemoryUsageLimitStore();
    const limits = (key: string) => ({ scopes: [{ key, limit: { tokens: 25 } }], store });
    const { agent, provider } = setup(
      [text("a"), finish(10)],
      [text("b"), finish(10)],
      [text("c"), finish(10)],
      [text("d"), finish(10)],
    );

    for (let i = 0; i < 3; i++) {
      expect((await agent.stream({ messages: [], usageLimits: limits("tenant:1") }).result()).finishReason).toBe(
        "stop",
      );
    }
    expect(store.get("tenant:1")).toEqual({ tokens: 30, steps: 3, toolCalls: 0 });

    // Spent: the next turn ends before the model is called.
    const over = await agent.stream({ messages: [], usageLimits: limits("tenant:1") }).result();
    expect(provider.calls).toHaveLength(3);
    expect(over.error).toMatchObject({
      code: "usage_limit",
      usageLimit: { scope: "tenant:1", metric: "tokens", limit: 25, used: 30 },
    });
    expect(over.messages.filter((message) => message.role === "assistant")).toEqual([]);

    // Another key has its own budget.
    const other = await agent.stream({ messages: [], usageLimits: limits("tenant:2") }).result();
    expect(other.finishReason).toBe("stop");
  });

  test("the client is not told the scope's key", async () => {
    const store = new MemoryUsageLimitStore();
    store.add("tenant:secret", { tokens: 0, steps: 5, toolCalls: 0 });
    const { agent } = setup();
    const run = agent.stream({
      messages: [],
      usageLimits: { scopes: [{ key: "tenant:secret", limit: { steps: 5 } }], store },
    });
    const frame = await errorFrame(run);
    expect(frame.error.message).toBe("The usage limit of 5 model calls has been reached.");
    expect(JSON.stringify(frame)).not.toContain("tenant:secret");
  });

  test("a store that can't be read fails the run rather than letting it go on unmetered", async () => {
    const { agent, provider } = setup([text("never"), finish()]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await agent
      .stream({
        messages: [],
        usageLimits: {
          scopes: [{ key: "k", limit: { tokens: 10 } }],
          store: {
            get: () => {
              throw new Error("down");
            },
            add: () => {},
          },
        },
      })
      .result();
    expect(provider.calls).toHaveLength(0);
    expect(result.error).toMatchObject({ code: "unknown", retryable: true });
    vi.restoreAllMocks();
  });
});

describe("onUsage", () => {
  test("hears each step's and tool batch's spending, then a final report", async () => {
    const reports: UsageReport[] = [];
    const { agent } = setup([toolCall("c1"), finish(10)], [text("ok"), finish(4)]);
    const result = await agent
      .stream({
        messages: [],
        threadId: "t_1",
        usageLimits: { scopes: [{ key: "u:1", limit: {} }], onUsage: (report) => void reports.push(report) },
      })
      .result();

    expect(reports.map((report) => [report.delta, report.final])).toEqual([
      [{ tokens: 10, steps: 1, toolCalls: 0 }, false],
      [{ tokens: 0, steps: 0, toolCalls: 1 }, false],
      [{ tokens: 4, steps: 1, toolCalls: 0 }, false],
      [{ tokens: 0, steps: 0, toolCalls: 0 }, true],
    ]);
    expect(reports.at(-1)).toMatchObject({
      runId: result.runId,
      threadId: "t_1",
      agent: "worker",
      scopes: ["u:1"],
      total: { tokens: 14, steps: 2, toolCalls: 1 },
    });
  });

  test("a throw is logged and the run goes on", async () => {
    const { agent } = setup([text("ok"), finish()]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await agent
      .stream({
        messages: [],
        usageLimits: {
          onUsage: () => {
            throw new Error("billing down");
          },
        },
      })
      .result();
    expect(result.finishReason).toBe("stop");
    expect(logged.mock.calls.flat().join(" ")).toContain("onUsage");
    vi.restoreAllMocks();
  });
});
