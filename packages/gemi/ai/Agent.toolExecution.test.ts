import { describe, expect, test } from "vitest";
import { Agent, AgentTool } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentStreamEvent } from "./types";

/**
 * #1161: `toolExecution: "sequential"` runs a step's tool calls one at a time,
 * in the order the model made them.
 */

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shared tree: `add` makes a node, `child` needs its parent to exist. */
function tree(log: string[]) {
  const nodes = new Set<string>();
  const add = AgentTool.create({
    name: "add",
    description: "Add a node",
    inputSchema: s.object({ id: s.string() }),
    execute: async ({ id }) => {
      log.push(`start add ${id}`);
      await sleep(20);
      nodes.add(id);
      log.push(`end add ${id}`);
      return id;
    },
  });
  const child = AgentTool.create({
    name: "child",
    description: "Add a child",
    inputSchema: s.object({ parent: s.string() }),
    execute: async ({ parent }) => {
      log.push(`start child ${parent}`);
      if (!nodes.has(parent)) throw new Error("parent not found");
      log.push(`end child ${parent}`);
      return `${parent}/child`;
    },
  });
  return [add, child] as const;
}

const script = () =>
  fakeProvider(
    [toolCall("c1", "add", { id: "a" }), toolCall("c2", "child", { parent: "a" }), finish()],
    [{ type: "text-delta", delta: "done" }, finish()],
  );

const statuses = (messages: { content: any[] }[]) =>
  messages.flatMap((m) => m.content.filter((p) => p.type === "tool-result")).map((p) => p.status);

describe("toolExecution (#1161)", () => {
  test("parallel by default: the calls start together", async () => {
    const log: string[] = [];
    const agent = Agent.create({ name: "a", provider: script(), tools: [...tree(log)] });
    const result = await agent.stream({ messages: [] }).result();
    expect(log.slice(0, 2)).toEqual(["start add a", "start child a"]);
    // Results land as calls settle: the child failed first.
    expect(statuses(result.messages)).toEqual(["error", "ok"]);
  });

  test("sequential: each call starts once the one before it settled, in the model's order", async () => {
    const log: string[] = [];
    const agent = Agent.create({
      name: "a",
      provider: script(),
      tools: [...tree(log)],
      toolExecution: "sequential",
    });
    const run = agent.stream({ messages: [] });
    const events: AgentStreamEvent[] = [];
    for await (const event of run) events.push(event);
    const result = await run.result();

    expect(log).toEqual(["start add a", "end add a", "start child a", "end child a"]);
    expect(statuses(result.messages)).toEqual(["ok", "ok"]);
    const order = events
      .filter((event) => event.type === "tool-result")
      .map((event) => (event as any).part?.toolCallId ?? (event as any).toolCallId);
    expect(order).toEqual(["c1", "c2"]);
  });

  test("a failed call does not stop the ones after it", async () => {
    const log: string[] = [];
    const provider = fakeProvider(
      [toolCall("c1", "child", { parent: "x" }), toolCall("c2", "add", { id: "b" }), finish()],
      [finish()],
    );
    const agent = Agent.create({ name: "a", provider, tools: [...tree(log)], toolExecution: "sequential" });
    const result = await agent.stream({ messages: [] }).result();
    expect(statuses(result.messages)).toEqual(["error", "ok"]);
    expect(log).toEqual(["start child x", "start add b", "end add b"]);
  });

  test("the run's option overrides the agent's", async () => {
    const log: string[] = [];
    const agent = Agent.create({ name: "a", provider: script(), tools: [...tree(log)] });
    const result = await agent.stream({ messages: [], toolExecution: "sequential" }).result();
    expect(statuses(result.messages)).toEqual(["ok", "ok"]);

    const back = [] as string[];
    const parallel = Agent.create({
      name: "b",
      provider: script(),
      tools: [...tree(back)],
      toolExecution: "sequential",
    });
    await parallel.stream({ messages: [], toolExecution: "parallel" }).result();
    expect(back.slice(0, 2)).toEqual(["start add a", "start child a"]);
  });

  test("a stop during a call: the calls after it never start", async () => {
    const started: string[] = [];
    const slow = AgentTool.create({
      name: "slow",
      description: "Slow",
      inputSchema: s.object({ id: s.string() }),
      execute: async ({ id }, ctx) => {
        started.push(id);
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
        return id;
      },
    });
    const provider = fakeProvider([
      toolCall("c1", "slow", { id: "1" }),
      toolCall("c2", "slow", { id: "2" }),
      finish(),
    ]);
    const agent = Agent.create({ name: "a", provider, tools: [slow], toolExecution: "sequential" });
    const run = agent.stream({ messages: [] });
    setTimeout(() => run.stop(), 20);
    const result = await run.result();
    await sleep(10);
    expect(result.finishReason).toBe("aborted");
    expect(started).toEqual(["1"]);
  });
});
