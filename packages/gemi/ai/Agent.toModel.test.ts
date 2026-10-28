process.env.SECRET ??= "agent-test-secret";

import { afterEach, describe, expect, test, vi } from "vitest";
import { Agent, AgentTool } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { MemoryAgentJobStore } from "./jobs/AgentJobStore";
import { overlayJobs } from "./jobs/overlay";
import { fakeProvider } from "./providers/fakeProvider";
import { toResponsesInput, toolResultOutput } from "./providers/request";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, ToolResultPart } from "./types";

// A tool result's model-facing projection (#1061).

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

const rows = Array.from({ length: 200 }, (_, i) => [i, `name ${i}`]);

const results = (messages: AgentMessage[]) =>
  messages.flatMap((message) => message.content.filter((part) => part.type === "tool-result")) as any[];

function queryTool(toModel?: (output: any) => unknown) {
  return AgentTool.create({
    name: "runQuery",
    description: "Run a read query",
    inputSchema: s.object({ sql: s.string() }),
    execute: async () => ({ columns: ["id", "name"], rows }),
    ...(toModel ? { toModel } : {}),
  });
}

const sample = (output: { columns: string[]; rows: unknown[][] }) => ({
  columns: output.columns,
  rowCount: output.rows.length,
  rows: output.rows.slice(0, 2),
  truncated: output.rows.length > 2,
});

/** What the provider was sent for the call's result on the follow-up request. */
function outputSentFor(provider: ReturnType<typeof fakeProvider>, toolCallId: string) {
  const request = provider.calls.at(-1)!;
  const input = toResponsesInput(request.messages, { toolSearch: false } as any, request.tools);
  const item = input.find(
    (entry: any) => entry.type === "function_call_output" && entry.call_id === toolCallId,
  ) as any;
  return item.output as string;
}

async function run(tool: AgentTool<string, any, any, any>) {
  const provider = fakeProvider(
    [toolCall("c1", tool.name, { sql: "select * from t" }), finish()],
    [{ type: "text-delta", delta: "200 rows" }, finish()],
  );
  const stream = Agent.create({ name: "analyst", provider, tools: [tool] }).stream({
    messages: [],
    turn: { text: "how many?" },
  });
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events, provider };
}

afterEach(() => vi.restoreAllMocks());

describe("toModel (#1061)", () => {
  test("the model reads the projection, the client and the store the whole output", async () => {
    const { result, events, provider } = await run(queryTool(sample));

    const part = results(result.messages)[0];
    expect(part.output.rows).toHaveLength(200);
    expect(part.modelOutput).toEqual({
      columns: ["id", "name"],
      rowCount: 200,
      rows: [
        [0, "name 0"],
        [1, "name 1"],
      ],
      truncated: true,
    });
    const frame = events.find((event) => event.type === "tool-result") as any;
    expect(frame.part.output.rows).toHaveLength(200);
    expect(frame.part.modelOutput).toEqual(part.modelOutput);
    expect(JSON.parse(outputSentFor(provider, "c1"))).toEqual(part.modelOutput);
  });

  test("a string is sent as is", async () => {
    const { result } = await run(queryTool((output) => `${output.rows.length} rows`));
    expect(toolResultOutput(results(result.messages)[0])).toBe("200 rows");
  });

  test("without toModel the model reads the output, and there is no modelOutput", async () => {
    const { result, provider } = await run(queryTool());
    const part = results(result.messages)[0];
    expect(part).not.toHaveProperty("modelOutput");
    expect(JSON.parse(outputSentFor(provider, "c1")).rows).toHaveLength(200);
  });

  test("a toModel that throws is logged, and the model reads the whole output", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, provider } = await run(
      queryTool(() => {
        throw new Error("bad projection");
      }),
    );
    expect(results(result.messages)[0]).not.toHaveProperty("modelOutput");
    expect(JSON.parse(outputSentFor(provider, "c1")).rows).toHaveLength(200);
    expect(logged.mock.calls.flat().join(" ")).toContain("toModel");
  });

  test("an async toModel is refused, and the model reads the whole output", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await run(queryTool((async () => "x") as never));
    expect(results(result.messages)[0]).not.toHaveProperty("modelOutput");
    expect(logged.mock.calls.flat().join(" ")).toContain("toModel");
  });

  test("a later turn replays the stored projection, not the output", async () => {
    const tool = queryTool(sample);
    const first = await run(tool);
    const provider = fakeProvider([{ type: "text-delta", delta: "ok" }, finish()]);
    await Agent.create({ name: "analyst", provider, tools: [tool] })
      .stream({ messages: first.result.messages, turn: { text: "and?" } })
      .result();
    expect(JSON.parse(outputSentFor(provider, "c1")).rowCount).toBe(200);
    expect(JSON.parse(outputSentFor(provider, "c1")).rows).toHaveLength(2);
  });

  test("errors and refusals are unchanged", () => {
    const error: ToolResultPart = {
      type: "tool-result",
      toolCallId: "c1",
      name: "x",
      status: "error",
      error: { code: "tool_error", message: "boom", retryable: true },
    };
    expect(toolResultOutput(error)).toContain("boom");
  });

  test("refused on a client tool, and when it is not a function", () => {
    expect(() =>
      AgentTool.create({
        name: "ask",
        description: "Ask",
        inputSchema: s.object({}),
        outputSchema: s.object({ answer: s.string() }),
        answeredBy: "client",
        toModel: (() => "x") as never,
      }),
    ).toThrow(/answered by the client/);
    expect(() => queryTool("nope" as never)).toThrow(/not a function/);
  });

  test("a background job's settled output gets the projection too", async () => {
    const store = new MemoryAgentJobStore();
    await store.create({
      id: "ajob_1",
      threadId: "t1",
      runId: "r1",
      toolCallId: "c1",
      toolName: "runQuery",
      owner: null,
      job: null,
      attachmentScope: null,
      deadlineMs: 60_000,
    } as any);
    await store.transition("ajob_1", ["running"], {
      state: "ok",
      output: { columns: ["id", "name"], rows },
      settledAt: Date.now(),
    });
    const messages: AgentMessage[] = [
      {
        id: "a1",
        role: "assistant",
        createdAt: new Date().toISOString(),
        content: [
          { type: "tool-call", toolCallId: "c1", name: "runQuery", input: {} },
          { type: "tool-result", toolCallId: "c1", name: "runQuery", status: "running", job: { id: "ajob_1" } },
        ],
      },
    ];
    const overlaid = await overlayJobs(messages, {
      threadId: "t1",
      store,
      isRunLive: () => false,
      modelOutputFor: (_name, output: any) => sample(output),
    });
    const part = results(overlaid.messages)[0];
    expect(part.status).toBe("ok");
    expect(part.output.rows).toHaveLength(200);
    expect(part.modelOutput.rowCount).toBe(200);
  });
});
