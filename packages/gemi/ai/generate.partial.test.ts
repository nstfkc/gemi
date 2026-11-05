process.env.SECRET ??= "agent-test-secret";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentTool, Agent } from "./Agent";
import type { ProviderEvent } from "./AgentProvider";
import { generate, type GeneratePartialInfo } from "./generate";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { Usage } from "./types";

// `generate({ onPartial })`: the answer heard while it streams (#1149).

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

/** The answer in the given pieces. */
const streamed = (pieces: string[], spent = usage(10, 5)): ProviderEvent[] => [
  ...pieces.map((delta): ProviderEvent => ({ type: "output-delta", delta })),
  { type: "finish", reason: "stop", usage: spent },
];

const LIST = s.object({
  title: s.string(),
  items: s.array(s.object({ id: s.number() })),
});

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Heard = { partial: unknown; info: GeneratePartialInfo };

describe("generate({ onPartial })", () => {
  test("hears the parsed answer after each piece that changed it", async () => {
    const heard: Heard[] = [];
    const provider = fakeProvider(
      streamed([
        '{"title": "Sho',
        'pping", "items": [{"id": 1',
        // Only the number completes; the value changes.
        "}, {",
        // Half a key: nothing new, no call.
        '"i',
        'd": 2}]}',
      ]),
    );
    const result = await generate({
      provider,
      prompt: "A list.",
      output: LIST,
      onPartial: (partial, info) => heard.push({ partial, info }),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      title: "Shopping",
      items: [{ id: 1 }, { id: 2 }],
    });
    expect(heard).toEqual([
      { partial: { title: "Sho" }, info: { attempt: 1, closed: [] } },
      {
        partial: { title: "Shopping", items: [{}] },
        info: { attempt: 1, closed: [] },
      },
      {
        partial: { title: "Shopping", items: [{ id: 1 }, {}] },
        info: { attempt: 1, closed: ["$.items[0]"] },
      },
      {
        partial: { title: "Shopping", items: [{ id: 1 }, { id: 2 }] },
        info: { attempt: 1, closed: ["$.items[1]", "$.items", "$"] },
      },
    ]);
  });

  test("a retry is heard as a new attempt, after the previous one's pieces", async () => {
    const events: string[] = [];
    const provider = fakeProvider(
      streamed(['{"title": "First", "items": [', "]}"]),
      streamed(['{"title": "Sec', 'ond", "items": [{"id": 7}]}']),
    );
    const result = await generate({
      provider,
      prompt: "A list.",
      output: LIST,
      validate: (list) => [list.items.length === 0 && "List at least one item."],
      attempts: 2,
      onAttempt: (attempt) => events.push(`attempt ${attempt.attempt}: ${attempt.outcome}`),
      onPartial: (partial, info) =>
        events.push(`partial ${info.attempt}: ${JSON.stringify(partial)} ${info.closed.join(",")}`),
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(events).toEqual([
      'partial 1: {"title":"First","items":[]} ',
      'partial 1: {"title":"First","items":[]} $.items,$',
      "attempt 1: rejected",
      'partial 2: {"title":"Sec"} ',
      'partial 2: {"title":"Second","items":[{"id":7}]} $.items[0],$.items,$',
      "attempt 2: passed",
    ]);
  });

  test("changes nothing about the result, usage or retries", async () => {
    const scripts = () => [
      streamed(['{"title": 1}']),
      streamed(['{"title": "x", "items": []}'], usage(3, 4)),
    ];
    const params = { prompt: "A list.", output: LIST, attempts: 2 };
    const without = await generate({
      ...params,
      provider: fakeProvider(...scripts()),
    });
    const heard: Heard[] = [];
    const withIt = await generate({
      ...params,
      provider: fakeProvider(...scripts()),
      onPartial: (partial, info) => heard.push({ partial, info }),
    });

    expect(heard.length).toBeGreaterThan(0);
    const strip = (result: typeof without) => ({
      ...result,
      messages: result.messages.map((m) => ({ ...m, id: "", createdAt: "" })),
      attemptLog: result.attemptLog.map((a) => ({ ...a, durationMs: 0 })),
    });
    expect(strip(withIt)).toEqual(strip(without));
  });

  test("a throwing listener is logged and the answer still arrives", async () => {
    const provider = fakeProvider(streamed(['{"title": "a", ', '"items": []}']));
    let calls = 0;
    const result = await generate({
      provider,
      prompt: "A list.",
      output: LIST,
      onPartial: () => {
        calls++;
        throw new Error("render failed");
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes("render failed"))).toBe(
      true,
    );
  });

  test("ctx.generate passes it through", async () => {
    const heard: Heard[] = [];
    const inner = fakeProvider(streamed(['{"title": "In', 'ner", "items": []}']));
    const tool = AgentTool.create({
      name: "draft",
      description: "x",
      inputSchema: s.object({}),
      execute: async (_input: any, ctx: any) => {
        const result = await ctx.generate({
          provider: inner,
          prompt: "A list.",
          output: LIST,
          onPartial: (partial: unknown, info: GeneratePartialInfo) => heard.push({ partial, info }),
        });
        return result.ok ? result.output.title : "failed";
      },
    });
    const outer = fakeProvider(
      [
        { type: "tool-call", toolCallId: "call_1", name: "draft", args: "{}" },
        { type: "finish", reason: "stop", usage: usage(1, 1) },
      ] as ProviderEvent[],
      [
        { type: "text-delta", delta: "Done." },
        { type: "finish", reason: "stop", usage: usage(1, 1) },
      ] as ProviderEvent[],
    );
    const agent = Agent.create({
      name: "writer",
      provider: outer,
      tools: [tool],
    });
    const run = agent.stream({ messages: [] });
    for await (const _event of run) {
      // drained
    }
    await run.result();

    expect(heard.map((h) => h.partial)).toEqual([{ title: "In" }, { title: "Inner", items: [] }]);
    expect(heard[1]!.info.closed).toEqual(["$.items", "$"]);
  });
});
