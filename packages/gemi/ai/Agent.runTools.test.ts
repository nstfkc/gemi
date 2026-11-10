process.env.SECRET ??= "agent-run-tools-test-secret";

import { describe, expect, test } from "vitest";
import { Agent, AgentTool, Skill, ToolNamespace } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "./types";

/**
 * #1123: a run's own tools (`AgentStreamParams.tools`) and which tools the
 * model is offered (`activeTools`), decided per turn.
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

const results = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

function echo(name: string, calls: string[] = []) {
  return AgentTool.create({
    name,
    description: `The ${name} tool`,
    inputSchema: s.object({}),
    execute: async () => {
      calls.push(name);
      return name;
    },
  });
}

/** The names of the tools a provider call was sent, namespaces as `ns/member`. */
function sent(tools: unknown): string[] {
  return ((tools as any[]) ?? []).flatMap((tool) =>
    tool.tools ? tool.tools.map((member: any) => `${tool.name}/${member.name}`) : [tool.name],
  );
}

describe("run tools (#1123)", () => {
  test("join the agent's for that run only, after its own and before skills", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(
      [toolCall("c1", "lookup", {}), finish()],
      [{ type: "text-delta", delta: "done" }, finish()],
      [finish()],
    );
    const agent = Agent.create({
      name: "a",
      provider,
      tools: [echo("search")],
      skills: [Skill.create({ name: "style", description: "Style", instructions: "be brief" })],
    });

    const result = await agent
      .stream({
        messages: [],
        tools: [echo("lookup", calls), ToolNamespace.create({ name: "crm", description: "CRM", tools: [echo("contacts")] })],
      })
      .result();

    expect(sent(provider.calls[0]!.tools)).toEqual(["search", "lookup", "crm/contacts", "skills/style"]);
    expect(calls).toEqual(["lookup"]);
    expect(results(result.messages)[0]).toMatchObject({ status: "ok", output: "lookup" });

    // The next run was given none.
    await agent.stream({ messages: [] }).result();
    expect(sent(provider.calls[2]!.tools)).toEqual(["search", "skills/style"]);
  });

  test("a run tool's per-run inputSchema is resolved like the agent's", async () => {
    const provider = fakeProvider([toolCall("c1", "pick", { field: "title" }), finish()], [finish()]);
    const pick = AgentTool.create({
      name: "pick",
      description: "Pick a field",
      inputSchema: ({ context }: { context: any }) => s.object({ field: s.enum(context.fields) }),
      execute: async (input: { field: string }) => input.field,
    });
    const agent = Agent.create({ name: "a", provider, tools: [] });
    const result = await agent
      .stream({ messages: [], tools: [pick as any], context: { fields: ["title", "body"] } } as any)
      .result();
    expect((provider.calls[0]!.tools as any[])[0].parameters.properties.field.enum).toEqual(["title", "body"]);
    expect(results(result.messages)[0]).toMatchObject({ status: "ok", output: "title" });
  });

  test("a name the agent already uses throws from stream", () => {
    const agent = Agent.create({
      name: "a",
      provider: fakeProvider(),
      tools: [echo("search"), ToolNamespace.create({ name: "crm", description: "CRM", tools: [echo("contacts")] })],
    });
    expect(() => agent.stream({ messages: [], tools: [echo("search")] })).toThrow(/"search".*already taken/);
    expect(() => agent.stream({ messages: [], tools: [echo("crm")] })).toThrow(/"crm".*already taken/);
    expect(() =>
      agent.stream({
        messages: [],
        tools: [ToolNamespace.create({ name: "crm", description: "x", tools: [echo("other")] })],
      }),
    ).toThrow(/namespace "crm"/);
    expect(() => agent.stream({ messages: [], tools: [echo("x"), echo("x")] })).toThrow(/Two tools/);
  });
});

describe("activeTools (#1123)", () => {
  test("only the named tools and namespaces are sent; skills always are", async () => {
    const provider = fakeProvider([finish()], [finish()]);
    const agent = Agent.create({
      name: "a",
      provider,
      tools: [
        echo("search"),
        echo("billing"),
        ToolNamespace.create({ name: "crm", description: "CRM", tools: [echo("contacts"), echo("deals")] }),
        ToolNamespace.create({ name: "docs", description: "Docs", tools: [echo("read"), echo("write")] }),
      ],
      skills: [Skill.create({ name: "style", description: "Style", instructions: "be brief" })],
    });

    await agent.stream({ messages: [], activeTools: ["search", "crm", "write"] }).result();
    expect(sent(provider.calls[0]!.tools)).toEqual([
      "search",
      "crm/contacts",
      "crm/deals",
      "docs/write",
      "skills/style",
    ]);

    // Without it, every tool, as before.
    await agent.stream({ messages: [] }).result();
    expect(sent(provider.calls[1]!.tools)).toHaveLength(7);
  });

  test("a call to a tool left out is answered as an unknown tool, and does not run", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(
      [toolCall("c1", "billing", {}), finish()],
      [{ type: "text-delta", delta: "ok" }, finish()],
    );
    const agent = Agent.create({ name: "a", provider, tools: [echo("search", calls), echo("billing", calls)] });
    const result = await agent.stream({ messages: [], activeTools: ["search"] }).result();
    expect(calls).toEqual([]);
    expect(results(result.messages)[0]).toMatchObject({
      status: "error",
      error: { code: "tool_error", message: 'There is no tool named "billing".' },
    });
  });

  test("covers the run's own tools too", async () => {
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [echo("search")] });
    await agent.stream({ messages: [], tools: [echo("lookup")], activeTools: ["lookup"] }).result();
    expect(sent(provider.calls[0]!.tools)).toEqual(["lookup"]);
  });

  test("an empty list offers no tool at all", async () => {
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [echo("search")] });
    await agent.stream({ messages: [], activeTools: [] }).result();
    expect(provider.calls[0]!.tools).toBeUndefined();
  });

  test("an unknown name throws from stream", () => {
    const agent = Agent.create({
      name: "a",
      provider: fakeProvider(),
      tools: [echo("search")],
      skills: [Skill.create({ name: "style", description: "Style", instructions: "x" })],
    });
    expect(() => agent.stream({ messages: [], activeTools: ["serach"] })).toThrow(/"serach"/);
    expect(() => agent.stream({ messages: [], activeTools: ["style"] })).toThrow(/Skills and memory/);
  });

  test("a pending approval is still answered on a turn that no longer offers its tool", async () => {
    const calls: string[] = [];
    const draw = AgentTool.create({
      name: "draw",
      description: "Draw",
      inputSchema: s.object({}),
      requiresApproval: true,
      execute: async () => {
        calls.push("draw");
        return "drawn";
      },
    });
    const first = Agent.create({
      name: "a",
      provider: fakeProvider([toolCall("c1", "draw", {}), finish()]),
      tools: [draw, echo("search")],
    }).stream({ messages: [], turn: { text: "draw" } });
    const events: AgentStreamEvent[] = [];
    for await (const event of first) events.push(event);
    const firstResult = await first.result();
    const pending = (events.find((event) => event.type === "awaiting-input") as any)
      .pending as PendingToolCall[];

    const provider = fakeProvider([{ type: "text-delta", delta: "done" }, finish()]);
    const second = await Agent.create({ name: "a", provider, tools: [draw, echo("search")] })
      .stream({
        messages: firstResult.messages,
        activeTools: ["search"],
        turn: { toolResults: [{ toolCallId: "c1", signature: pending[0]!.signature, approve: true }] },
      })
      .result();

    expect(calls).toEqual(["draw"]);
    expect(results(second.messages)[0]).toMatchObject({ status: "ok", output: "drawn" });
    expect(sent(provider.calls[0]!.tools)).toEqual(["search"]);
  });
});

describe("prepareStep: activeTools and toolChoice for one call (#1010)", () => {
  test("activeTools narrows one call; the next step offers the run's tools again", async () => {
    const provider = fakeProvider(
      [toolCall("c1", "search", {}), finish()],
      [{ type: "text-delta", delta: "done" }, finish()],
    );
    const seen: (readonly string[] | undefined)[] = [];
    const agent = Agent.create({
      name: "a",
      provider,
      tools: [
        echo("search"),
        echo("askUser"),
        ToolNamespace.create({ name: "crm", description: "CRM", tools: [echo("contacts"), echo("deals")] }),
      ],
      skills: [Skill.create({ name: "style", description: "Style", instructions: "be brief" })],
      prepareStep: ({ step }) => (step === 1 ? { activeTools: ["search", "crm"] } : undefined),
    });
    await agent
      .stream({
        messages: [],
        prepareStep: ({ activeTools }) => {
          seen.push(activeTools);
        },
      })
      .result();

    expect(sent(provider.calls[0]!.tools)).toEqual(["search", "crm/contacts", "crm/deals", "skills/style"]);
    expect(sent(provider.calls[1]!.tools)).toEqual([
      "search",
      "askUser",
      "crm/contacts",
      "crm/deals",
      "skills/style",
    ]);
    // A later hook sees what an earlier one answered.
    expect(seen).toEqual([["search", "crm"], undefined]);
  });

  test("a call to a tool the step left out is answered as an unknown tool", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(
      [toolCall("c1", "askUser", {}), finish()],
      [{ type: "text-delta", delta: "ok" }, finish()],
    );
    const agent = Agent.create({
      name: "a",
      provider,
      tools: [echo("search", calls), echo("askUser", calls)],
      prepareStep: () => ({ activeTools: ["search"] }),
    });
    const result = await agent.stream({ messages: [] }).result();
    expect(calls).toEqual([]);
    expect(results(result.messages)[0]).toMatchObject({
      status: "error",
      error: { code: "tool_error", message: 'There is no tool named "askUser".' },
    });
  });

  test("works inside the run's activeTools, and a name outside them fails the run", async () => {
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [echo("search"), echo("billing")] });
    const ok = await agent
      .stream({ messages: [], activeTools: ["search", "billing"], prepareStep: () => ({ activeTools: ["billing"] }) })
      .result();
    expect(ok.finishReason).toBe("stop");
    expect(sent(provider.calls[0]!.tools)).toEqual(["billing"]);

    const failed = await agent
      .stream({ messages: [], activeTools: ["search"], prepareStep: () => ({ activeTools: ["billing"] }) })
      .result();
    expect(failed.finishReason).toBe("error");
    expect(failed.error?.message).toMatch(/prepareStep \(step 1\).*"billing"/);
    expect(provider.calls).toHaveLength(1);
  });

  test("toolChoice is sent for that call alone", async () => {
    const provider = fakeProvider(
      [toolCall("c1", "search", {}), finish()],
      [{ type: "text-delta", delta: "done" }, finish()],
    );
    const agent = Agent.create({
      name: "a",
      provider,
      tools: [echo("search"), echo("askUser")],
      prepareStep: ({ step }) => (step === 1 ? { toolChoice: { name: "search" } } : { toolChoice: "none" }),
    });
    await agent.stream({ messages: [] }).result();
    expect(provider.calls[0]!.toolChoice).toEqual({ name: "search" });
    expect(provider.calls[1]!.toolChoice).toBe("none");
    // "none" keeps the tool list, so the prompt prefix is the same.
    expect(sent(provider.calls[1]!.tools)).toEqual(sent(provider.calls[0]!.tools));

    const plain = fakeProvider([finish()]);
    await Agent.create({ name: "b", provider: plain, tools: [echo("search")] }).stream({ messages: [] }).result();
    expect("toolChoice" in plain.calls[0]!).toBe(false);
  });

  test("forcing a tool the call does not offer fails the run before the call", async () => {
    const provider = fakeProvider([finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [echo("search"), echo("askUser")] });

    const hidden = await agent
      .stream({ messages: [], prepareStep: () => ({ activeTools: ["search"], toolChoice: { name: "askUser" } }) })
      .result();
    expect(hidden.finishReason).toBe("error");
    expect(hidden.error?.message).toMatch(/toolChoice.*"askUser"/);

    const unknown = await agent
      .stream({ messages: [], prepareStep: () => ({ toolChoice: { name: "nope" } }) })
      .result();
    expect(unknown.error?.message).toMatch(/"nope"/);

    const required = await agent
      .stream({ messages: [], prepareStep: () => ({ activeTools: [], toolChoice: "required" }) })
      .result();
    expect(required.error?.message).toMatch(/offers no tools/);
    expect(provider.calls).toHaveLength(0);
  });
});
