import { afterEach, describe, expect, test } from "vitest";
import { Agent, AgentTool, type ToolContext } from "./Agent";
import { generate } from "./generate";
import { ImageModel } from "./ImageModel";
import { fakeImageProvider, fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { UsageTotals } from "./usageMeter";
import { measureUsage, Usage } from "./usageMeter";

const finish = (inputTokens: number, outputTokens: number, model?: string) => ({
  type: "finish" as const,
  reason: "stop" as const,
  usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  ...(model ? { model } : {}),
});

describe("measureUsage", () => {
  test("sums every model call inside, by model, however deep", async () => {
    const agentProvider = fakeProvider([
      { type: "text-delta", delta: "hi" },
      finish(100, 10, "gpt-x-2026"),
    ]);
    const judgeProvider = fakeProvider([
      { type: "output-delta", delta: '{"ok":true}' },
      finish(20, 2),
    ]);
    const agent = Agent.create({ name: "a", provider: agentProvider });

    const measured = await measureUsage(async () => {
      await agent.stream({ messages: [] }).result();
      // A call made from nested app code, not handed anything.
      await (async () =>
        generate({
          provider: judgeProvider,
          prompt: "x",
          output: s.object({ ok: s.boolean() }),
        }))();
      return "done";
    });

    expect(measured.value).toBe("done");
    expect(measured.usage).toMatchObject({ inputTokens: 120, outputTokens: 12 });
    expect(measured.byModel["gpt-x-2026"]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(measured.byModel.fake).toMatchObject({ inputTokens: 20, outputTokens: 2 });
  });

  test("meters nest, and concurrent meters don't see each other's calls", async () => {
    const provider = () =>
      fakeProvider([{ type: "output-delta", delta: '{"ok":true}' }, finish(5, 1)]);
    const call = () =>
      generate({ provider: provider(), prompt: "x", output: s.object({ ok: s.boolean() }) });

    const outer = await measureUsage(async () => {
      const [a, b] = await Promise.all([measureUsage(call), measureUsage(call)]);
      expect(a.usage.inputTokens).toBe(5);
      expect(b.usage.inputTokens).toBe(5);
      await call();
    });
    expect(outer.usage.inputTokens).toBe(15);
  });

  test("a call outside any meter is not recorded anywhere", async () => {
    const before = await measureUsage(() => 1);
    await generate({
      provider: fakeProvider([{ type: "output-delta", delta: '{"ok":true}' }, finish(5, 1)]),
      prompt: "x",
      output: s.object({ ok: s.boolean() }),
    });
    expect(before.usage.inputTokens).toBe(0);
  });
});

// --- costs (#1021) -----------------------------------------------------------

const judge = (inputTokens: number, outputTokens: number, model?: string) =>
  generate({
    provider: fakeProvider([
      { type: "output-delta", delta: '{"ok":true}' },
      finish(inputTokens, outputTokens, model),
    ]),
    prompt: "x",
    output: s.object({ ok: s.boolean() }),
  });

/** Micros: 1 per input token and 10 per output token for "fake", nothing else priced. */
const micros = (model: string, usage: Usage) =>
  model === "fake" ? usage.inputTokens + usage.outputTokens * 10 : undefined;

afterEach(() => Usage.configure({ pricing: undefined }));

describe("Usage.meter", () => {
  test("prices each call at its own model's prices, from a table in USD per million", async () => {
    const metered = await Usage.meter(
      async () => {
        await judge(1_000_000, 0, "gpt-x-2026-01-01");
        await judge(0, 1_000_000, "gpt-x-mini");
        await judge(10, 1, "other");
        return 7;
      },
      { pricing: { "gpt-x": { input: 2, output: 10 }, "gpt-x-mini": { input: 0.5, output: 1 } } },
    );

    expect(metered.value).toBe(7);
    // The longest prefix wins: gpt-x-mini is not priced as gpt-x.
    expect(metered.byModel["gpt-x-2026-01-01"]).toMatchObject({ cost: 2, count: 1 });
    expect(metered.byModel["gpt-x-mini"]).toMatchObject({ cost: 1, count: 1 });
    expect(metered.byModel.other).toMatchObject({ cost: 0, count: 1 });
    expect(metered.cost).toBe(3);
    expect(metered.unpriced).toEqual(["other"]);
    expect(metered.usage).toMatchObject({ inputTokens: 1_000_010, outputTokens: 1_000_001 });
  });

  test("adds costs that are not model calls under a label, and labelled scopes attribute their calls", async () => {
    Usage.configure({ pricing: micros });

    const metered = await Usage.meter(async (meter) => {
      await judge(100, 1);
      meter.add("browser", 2000);
      await Usage.meter(
        async () => {
          await judge(50, 5);
          // From deep code, without the handle: the innermost meter and every one around it.
          Usage.add("browser", 2000);
        },
        { label: "critique" },
      );
    });

    expect(metered.cost).toBe(110 + 2000 + 100 + 2000);
    expect(metered.byLabel.browser).toMatchObject({ cost: 4000, count: 2 });
    expect(metered.byLabel.critique).toMatchObject({ cost: 100, count: 1 });
    expect(metered.byLabel.critique!.usage).toMatchObject({ inputTokens: 50, outputTokens: 5 });
    // The unlabelled call is in the totals and by model, not under a label.
    expect(metered.byModel.fake).toMatchObject({ cost: 210, count: 2 });
    expect(Object.keys(metered.byLabel).sort()).toEqual(["browser", "critique"]);
  });

  test("a meter's own pricing overrides the configured one, and inner meters inherit it", async () => {
    Usage.configure({ pricing: micros });
    const flat = () => 1;

    const outer = await Usage.meter(
      async () => {
        const inner = await Usage.meter(() => judge(100, 1));
        expect(inner.cost).toBe(1);
      },
      { pricing: flat },
    );
    expect(outer.cost).toBe(1);

    const configured = await Usage.meter(() => judge(100, 1));
    expect(configured.cost).toBe(110);
  });

  test("without pricing, calls are counted and listed as unpriced", async () => {
    const metered = await Usage.meter(() => judge(5, 1));
    expect(metered.cost).toBe(0);
    expect(metered.unpriced).toEqual(["fake"]);
    expect(metered.byModel.fake!.usage).toMatchObject({ inputTokens: 5, outputTokens: 1 });
  });

  test("meters images, and calls recorded by hand", async () => {
    Usage.configure({
      pricing: {
        "fake-image": { input: 5, output: 10, imageOutput: 30 },
        transcribe: { input: 1, output: 0 },
      },
    });
    const model = ImageModel.create({ name: "banner", provider: fakeImageProvider() });

    const metered = await Usage.meter(async () => {
      await model.generate({ prompt: "a street" });
      Usage.record("transcribe", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      });
    });

    // 15 text input tokens at 5, 196 image output tokens at 30.
    expect(metered.byModel["fake-image"]!.cost).toBeCloseTo((15 * 5 + 196 * 30) / 1_000_000);
    expect(metered.byModel.transcribe!.cost).toBe(1);
  });

  test("outside a meter, add, record and current do nothing; a settled meter stops counting", async () => {
    expect(Usage.current()).toBeUndefined();
    Usage.add("browser", 1);
    Usage.record("fake", { inputTokens: 1, outputTokens: 1, totalTokens: 2 });

    let kept: ReturnType<typeof Usage.current>;
    const metered = await Usage.meter(async (meter) => {
      kept = Usage.current();
      expect(kept).toBe(meter);
    });
    kept!.add("late", 5);
    expect(kept!.totals().byLabel.late).toBeUndefined();
    expect(metered.cost).toBe(0);
  });

  test("measureUsage keeps its shape", async () => {
    const measured = await measureUsage(() => judge(3, 1));
    expect(Object.keys(measured).sort()).toEqual(["byModel", "usage", "value"]);
    expect(measured.byModel.fake).toMatchObject({ inputTokens: 3, outputTokens: 1 });
  });
});

describe("a run's meter", () => {
  const toolCall = (toolCallId: string, name: string) => ({
    type: "tool-call" as const,
    toolCallId,
    name,
    args: "{}",
  });

  test("result.metered covers the run, its tools' generates, sub-runs and ctx.meter.add, once each", async () => {
    Usage.configure({ pricing: micros });
    const sub = Agent.create({
      name: "sub",
      provider: fakeProvider([{ type: "text-delta", delta: "ok" }, finish(1000, 10)]),
    });
    let seen: UsageTotals | undefined;
    const review = AgentTool.create({
      name: "review",
      description: "x",
      inputSchema: s.object({}),
      outputSchema: s.object({ ok: s.boolean() }),
      execute: async (_input: unknown, ctx: ToolContext) => {
        await ctx.generate({
          provider: fakeProvider([{ type: "output-delta", delta: '{"ok":true}' }, finish(100, 1)]),
          prompt: "x",
          output: s.object({ ok: s.boolean() }),
        });
        await ctx.runAgent(sub, { prompt: "go" });
        ctx.meter.add("browser", 2000);
        seen = ctx.meter.totals();
        return { ok: true };
      },
    });
    const agent = Agent.create({
      name: "lead",
      provider: fakeProvider(
        [toolCall("c1", "review"), finish(10, 1)],
        [{ type: "text-delta", delta: "done" }, finish(20, 2)],
      ),
      tools: [review],
    });

    const outer = await Usage.meter(() => agent.stream({ messages: [] }).result());
    const result = outer.value;

    // lead: 20 + 40; tool generate: 110; sub-run: 1100; browser: 2000.
    expect(result.metered!.cost).toBe(20 + 40 + 110 + 1100 + 2000);
    expect(result.metered!.usage.inputTokens).toBe(result.usage.inputTokens);
    expect(result.metered!.byLabel.browser).toMatchObject({ cost: 2000, count: 1 });
    expect(result.metered!.byModel.fake!.count).toBe(4);
    // Live from inside the tool: everything but the lead's last step.
    expect(seen!.cost).toBe(20 + 110 + 1100 + 2000);
    // The meter the run started in sees the same, not twice.
    expect(outer.cost).toBe(result.metered!.cost);
  });

  test("concurrent runs keep separate meters", async () => {
    Usage.configure({ pricing: micros });
    const agent = (tokens: number) =>
      Agent.create({
        name: "a",
        provider: fakeProvider([{ type: "text-delta", delta: "x" }, finish(tokens, 0)]),
      });

    const [a, b] = await Promise.all([
      agent(5).stream({ messages: [] }).result(),
      agent(7).stream({ messages: [] }).result(),
    ]);
    expect(a.metered!.cost).toBe(5);
    expect(b.metered!.cost).toBe(7);
  });
});
