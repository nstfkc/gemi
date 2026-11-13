import { expect, test, vi } from "vitest";
import { Agent, AgentRunError, AgentTool, ToolArgumentsTooLongError } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage } from "./types";

// #1259: a tool call cut at `maxToolArgumentChars` is a typed failure, and can
// go back to the model as that call's error instead of failing the run.

const finish = (reason: "stop" | "error" = "stop"): ProviderEvent => ({
  type: "finish",
  reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const cut = (toolCallId: string): ProviderEvent[] => [
  { type: "tool-call-delta", toolCallId, name: "write", argsDelta: '{"body":"aaaa' },
  {
    type: "error",
    error: {
      code: "provider_error",
      message: `Provider streamed more than 100 characters of arguments for "write" without finishing the call (maxToolArgumentChars)`,
      retryable: true,
    },
    toolArgumentsTooLong: { tool: "write", toolCallId, limit: 100, chars: 104 },
  },
  finish("error"),
];

const write = AgentTool.create({
  name: "write",
  description: "Write a page",
  inputSchema: s.object({ body: s.string() }),
  execute: async ({ body }) => ({ wrote: body.length }),
});

const results = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

test("the run's error says which call was cut, and at what limit", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const agent = Agent.create({ name: "writer", provider: fakeProvider(cut("c1")), tools: [write] });

  const result = await agent.stream({ messages: [], turn: { text: "write" } }).result();

  expect(result.finishReason).toBe("error");
  expect(result.error).toMatchObject({ code: "provider_error", retryable: true });
  expect(result.error?.toolArgumentsTooLong).toEqual({
    tool: "write",
    toolCallId: "c1",
    limit: 100,
    chars: 104,
  });
});

test("throwOnError rejects with a ToolArgumentsTooLongError", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const agent = Agent.create({ name: "writer", provider: fakeProvider(cut("c1")), tools: [write] });

  const error = await agent
    .stream({ messages: [], turn: { text: "write" } })
    .result({ throwOnError: true })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ToolArgumentsTooLongError);
  expect(error).toBeInstanceOf(AgentRunError);
  expect(error).toMatchObject({
    tool: "write",
    toolCallId: "c1",
    limit: 100,
    chars: 104,
    code: "provider_error",
  });
});

test("another failure still rejects with a plain AgentRunError", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const agent = Agent.create({
    name: "writer",
    provider: fakeProvider([
      { type: "error", error: { code: "provider_error", message: "down", retryable: true } },
      finish("error"),
    ]),
  });
  const error = await agent
    .stream({ messages: [], turn: { text: "hi" } })
    .result({ throwOnError: true })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AgentRunError);
  expect(error).not.toBeInstanceOf(ToolArgumentsTooLongError);
});

test('onToolArgumentsTooLong { toolError } sends the cut call back to the model as its error', async () => {
  const provider = fakeProvider(cut("c1"), [{ type: "text-delta", delta: "I'll split it." }, finish()]);
  const agent = Agent.create({
    name: "writer",
    provider,
    tools: [write],
    onToolArgumentsTooLong: { toolError: 1 },
  });

  const result = await agent.stream({ messages: [], turn: { text: "write" } }).result();

  expect(result.finishReason).toBe("stop");
  expect(result.error).toBeUndefined();
  expect(provider.calls).toHaveLength(2);
  const call = result.messages
    .flatMap((message) => message.content)
    .find((part) => part.type === "tool-call") as any;
  // The cut arguments are not sent back: they are not JSON, and they are long.
  expect(call).toMatchObject({ toolCallId: "c1", name: "write", input: {} });
  expect(results(result.messages)).toEqual([
    expect.objectContaining({
      toolCallId: "c1",
      status: "error",
      error: expect.objectContaining({
        code: "invalid_tool_input",
        retryable: true,
        message: expect.stringContaining("smaller calls"),
      }),
    }),
  ]);
  expect(results(result.messages)[0].error.message).toContain("100");
});

test("past its budget the next cut fails the run", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const provider = fakeProvider(cut("c1"), cut("c2"));
  const agent = Agent.create({
    name: "writer",
    provider,
    tools: [write],
    onToolArgumentsTooLong: { toolError: 1 },
  });

  const result = await agent.stream({ messages: [], turn: { text: "write" } }).result();

  expect(provider.calls).toHaveLength(2);
  expect(result.finishReason).toBe("error");
  expect(result.error?.toolArgumentsTooLong).toMatchObject({ toolCallId: "c2" });
});

test("calls that finished in the same step still run", async () => {
  const ran: string[] = [];
  const lookup = AgentTool.create({
    name: "lookup",
    description: "Look up",
    inputSchema: s.object({ q: s.string() }),
    execute: async ({ q }) => {
      ran.push(q);
      return { found: q };
    },
  });
  const provider = fakeProvider(
    [{ type: "tool-call", toolCallId: "l1", name: "lookup", args: '{"q":"a"}' }, ...cut("c1")],
    [{ type: "text-delta", delta: "done" }, finish()],
  );
  const agent = Agent.create({
    name: "writer",
    provider,
    tools: [write, lookup],
    onToolArgumentsTooLong: { toolError: 2 },
  });

  const result = await agent.stream({ messages: [], turn: { text: "write" } }).result();

  expect(result.finishReason).toBe("stop");
  expect(ran).toEqual(["a"]);
  expect(results(result.messages).map((part) => [part.toolCallId, part.status])).toEqual([
    ["c1", "error"],
    ["l1", "ok"],
  ]);
});

test("rejects an onToolArgumentsTooLong it cannot read", () => {
  for (const value of ["tool-error", { toolError: 0 }, { toolError: 1.5 }]) {
    expect(() =>
      Agent.create({ name: "writer", provider: fakeProvider(), onToolArgumentsTooLong: value as any }),
    ).toThrow(/onToolArgumentsTooLong/);
  }
});
