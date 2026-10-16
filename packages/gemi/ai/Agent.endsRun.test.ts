process.env.SECRET ??= "agent-test-secret";

import { describe, expect, test, vi } from "vitest";
import { Agent, AgentTool, type ToolEndsRunContext } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { toResponsesInput } from "./providers/request";
import { ToolError } from "./redact";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent } from "./types";

// A tool result that ends the run (#974).

const toolCall = (toolCallId: string, name: string, args: unknown): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: JSON.stringify(args),
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

const reply = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];

function tweakTool(endsRun: any, execute?: (input: { px: number }) => Promise<unknown>) {
  return AgentTool.create({
    name: "tweak",
    description: "Tweak a style",
    inputSchema: s.object({ px: s.number() }),
    execute: execute ?? (async (input: { px: number }) => ({ ok: true, px: input.px })),
    endsRun,
  });
}

function otherTool() {
  return AgentTool.create({
    name: "other",
    description: "Something else",
    inputSchema: s.object({ px: s.number() }),
    execute: async () => ({ done: true }),
  });
}

async function run(
  agent: { stream: (params: any) => any },
  params: Record<string, unknown> = {},
) {
  const reported: AgentMessage[] = [];
  const stream = agent.stream({
    messages: [],
    turn: { text: "pad it" },
    onMessage: (message: AgentMessage) => {
      reported.push(message);
    },
    ...params,
  });
  const events: AgentStreamEvent[] = [];
  const done = (async () => {
    for await (const event of stream) events.push(event);
  })();
  const result = await stream.result();
  await done;
  return { result, events, reported };
}

const texts = (message: AgentMessage | undefined) =>
  (message?.content ?? [])
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("");

describe("endsRun", () => {
  test("a string ends the run with it as the closing message, without another model call", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 40 }), finish()], reply("never"));
    const endsRun = vi.fn((output: any) => `The links now sit ${output.px}px from the edge.`);
    const agent = Agent.create({ name: "site", provider, tools: [tweakTool(endsRun)] });

    const { result, events, reported } = await run(agent);

    expect(provider.calls).toHaveLength(1);
    expect(result.finishReason).toBe("stop");
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    const [, toolMessage, closing] = result.messages;
    expect(toolMessage.content.map((part) => part.type)).toEqual(["tool-call", "tool-result"]);
    expect(closing.content).toEqual([
      { type: "text", text: "The links now sit 40px from the edge." },
    ]);
    expect(closing.finishReason).toBe("stop");
    expect(closing.usage).toBeUndefined();
    // Billed for the one model call it made.
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });

    // Streamed like a model's reply, and persisted like one.
    expect(events).toContainEqual({ type: "message-start", messageId: closing.id, role: "assistant" });
    expect(events).toContainEqual({
      type: "text-delta",
      messageId: closing.id,
      delta: "The links now sit 40px from the edge.",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message-end", messageId: closing.id, finishReason: "stop" }),
    );
    expect(events.at(-1)).toMatchObject({ type: "run-end", finishReason: "stop" });
    expect(reported.map((message) => message.id)).toEqual(result.messages.map((message) => message.id));

    const ctx = endsRun.mock.calls[0][1] as ToolEndsRunContext;
    expect(ctx).toMatchObject({ input: { px: 40 }, toolCallId: "c1", step: 1, depth: 0 });
    expect(ctx.runId).toBe(result.runId);
  });

  test("the thread stays a valid provider history for the next turn", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 40 }), finish()], reply("ok"));
    const agent = Agent.create({ name: "site", provider, tools: [tweakTool(() => "Done.")] });
    const first = await agent.stream({ messages: [], turn: { text: "pad it" } }).result();

    await agent.stream({ messages: first.messages, turn: { text: "more" } }).result();

    const sent = provider.calls[1].messages;
    const items = toResponsesInput(sent, provider.capabilities as any);
    expect(items.map((item) => [item.type, item.role ?? null])).toEqual([
      ["message", "user"],
      ["function_call", null],
      ["function_call_output", null],
      ["message", "assistant"],
      ["message", "user"],
    ]);
    expect((items[3].content as any[])[0]).toEqual({ type: "output_text", text: "Done." });
  });

  test("true ends the run with no closing message", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 1 }), finish()], reply("never"));
    const agent = Agent.create({ name: "site", provider, tools: [tweakTool(true)] });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(1);
    expect(result.finishReason).toBe("stop");
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("an empty string ends it the same way", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 1 }), finish()], reply("never"));
    const agent = Agent.create({ name: "site", provider, tools: [tweakTool(() => "")] });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(1);
    expect(result.messages).toHaveLength(2);
  });

  test.each([[null], [undefined], [false]])("%s carries on to the model", async (answer) => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 1 }), finish()], reply("Padded."));
    const agent = Agent.create({ name: "site", provider, tools: [tweakTool(() => answer)] });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(2);
    expect(texts(result.messages.at(-1))).toBe("Padded.");
  });

  test("an async function is awaited", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 1 }), finish()], reply("never"));
    const agent = Agent.create({
      name: "site",
      provider,
      tools: [tweakTool(async () => "Async done.")],
    });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(1);
    expect(texts(result.messages.at(-1))).toBe("Async done.");
  });

  test("a failed call goes back to the model, and the function is not asked", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 1 }), finish()], reply("Sorry."));
    const endsRun = vi.fn(() => "Done.");
    const agent = Agent.create({
      name: "site",
      provider,
      tools: [
        tweakTool(endsRun, async () => {
          throw new ToolError("no such element");
        }),
      ],
    });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(2);
    expect(endsRun).not.toHaveBeenCalled();
    expect(texts(result.messages.at(-1))).toBe("Sorry.");
  });

  test("invalid input goes back to the model", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: "wide" }), finish()], reply("Retry."));
    const agent = Agent.create({ name: "site", provider, tools: [tweakTool(true)] });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(2);
    expect(result.finishReason).toBe("stop");
  });

  test("a function that throws is logged and the run carries on", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 1 }), finish()], reply("Carried on."));
    const agent = Agent.create({
      name: "site",
      provider,
      tools: [
        tweakTool(() => {
          throw new Error("boom");
        }),
      ],
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(2);
    expect(texts(result.messages.at(-1))).toBe("Carried on.");
    expect(String(errors.mock.calls[0]?.[0])).toContain('the endsRun of "tweak" threw');
    errors.mockRestore();
  });

  test("parallel calls that all end join their texts in call order", async () => {
    const provider = fakeProvider(
      [toolCall("c1", "tweak", { px: 1 }), toolCall("c2", "tweak", { px: 2 }), finish()],
      reply("never"),
    );
    const agent = Agent.create({
      name: "site",
      provider,
      tools: [
        tweakTool(
          (output: any) => `Set ${output.px}.`,
          async (input) => {
            // The second call settles first: the order is the model's, not the clock's.
            await new Promise((resolve) => setTimeout(resolve, input.px === 1 ? 20 : 0));
            return { px: input.px };
          },
        ),
      ],
    });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(1);
    expect(texts(result.messages.at(-1))).toBe("Set 1.\n\nSet 2.");
  });

  test("one call that does not end keeps the run going", async () => {
    const provider = fakeProvider(
      [toolCall("c1", "tweak", { px: 1 }), toolCall("c2", "other", { px: 2 }), finish()],
      reply("Both done."),
    );
    const agent = Agent.create({
      name: "site",
      provider,
      tools: [tweakTool(() => "Done."), otherTool()],
    });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(2);
    expect(texts(result.messages.at(-1))).toBe("Both done.");
    expect(result.messages.some((message) => texts(message) === "Done.")).toBe(false);
  });

  test("a pending call in the same step ends the run awaiting-input", async () => {
    const ask = AgentTool.create({
      name: "confirm",
      description: "Ask first",
      inputSchema: s.object({ px: s.number() }),
      requiresApproval: true,
      execute: async () => ({ ok: true }),
    });
    const provider = fakeProvider(
      [toolCall("c1", "tweak", { px: 1 }), toolCall("c2", "confirm", { px: 2 }), finish()],
      reply("never"),
    );
    const agent = Agent.create({ name: "site", provider, tools: [tweakTool(() => "Done."), ask] });

    const { result } = await run(agent);

    expect(result.finishReason).toBe("awaiting-input");
    expect(result.messages).toHaveLength(2);
  });

  test("ending on the last allowed step is a stop, not max-steps", async () => {
    const provider = fakeProvider([toolCall("c1", "tweak", { px: 1 }), finish()]);
    const agent = Agent.create({
      name: "site",
      provider,
      tools: [tweakTool(() => "Done.")],
      maxSteps: 1,
    });

    const { result } = await run(agent);

    expect(result.finishReason).toBe("stop");
    expect(texts(result.messages.at(-1))).toBe("Done.");
  });

  test("a sub-agent's tool ends the sub-run, and the parent carries on", async () => {
    const sub = Agent.create({
      name: "styler",
      provider: fakeProvider([toolCall("s1", "tweak", { px: 3 }), finish()], reply("never")),
      tools: [tweakTool(() => "Styled.")],
    });
    let nestedText = "";
    const delegate = AgentTool.create({
      name: "delegate",
      description: "Hand it to the styler",
      inputSchema: s.object({ px: s.number() }),
      execute: async (_input: unknown, ctx: any) => {
        const nested = await ctx.runAgent(sub, { prompt: "style it" });
        nestedText = texts(nested.messages.at(-1));
        return { finishReason: nested.finishReason };
      },
    });
    const provider = fakeProvider([toolCall("c1", "delegate", { px: 3 }), finish()], reply("All set."));
    const agent = Agent.create({ name: "site", provider, tools: [delegate] });

    const { result } = await run(agent);

    expect(nestedText).toBe("Styled.");
    expect(provider.calls).toHaveLength(2);
    expect(texts(result.messages.at(-1))).toBe("All set.");
  });

  test("a client tool cannot set it", () => {
    expect(() =>
      AgentTool.create({
        name: "pick",
        description: "x",
        inputSchema: s.object({ px: s.number() }),
        outputSchema: s.object({ px: s.number() }),
        answeredBy: "client",
        endsRun: true,
      } as any),
    ).toThrow(/answered by the client and cannot set `endsRun`/);
  });

  test("a tool without it is unchanged", async () => {
    const provider = fakeProvider([toolCall("c1", "other", { px: 1 }), finish()], reply("Done."));
    const agent = Agent.create({ name: "site", provider, tools: [otherTool()] });

    const { result } = await run(agent);

    expect(provider.calls).toHaveLength(2);
    expect(otherTool().endsRun).toBeUndefined();
    expect(result.finishReason).toBe("stop");
  });
});
