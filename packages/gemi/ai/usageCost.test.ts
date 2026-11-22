import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Agent, AgentTool, type ToolContext } from "./Agent";
import { AnthropicProvider, OpenAIProvider } from "./AgentProvider";
import { FallbackProvider } from "./FallbackProvider";
import { generate } from "./generate";
import { ImageModel } from "./ImageModel";
import { fakeImageProvider, fakeProvider } from "./providers/fakeProvider";
import { addUsage } from "./runtime";
import { s } from "./Schema";
import { MemoryAttachmentStore, ScopedAttachments } from "./store/Attachments";
import type { UsageReport } from "./usageLimits";
import { priceUsage, resetUnpricedWarnings, Usage, withCost } from "./usageMeter";

/**
 * `Usage.costUsd` (#1146): each model call priced at the `ModelPrices` table
 * when it finishes, summed with the usage, server-side only.
 */

const finish = (inputTokens: number, outputTokens: number, model?: string) => ({
  type: "finish" as const,
  reason: "stop" as const,
  usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  ...(model ? { model } : {}),
});
const usage = (inputTokens: number, outputTokens: number, extra = {}) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  ...extra,
});
/** USD per million tokens: $1 in, $10 out. */
const prices = { fake: { input: 1, output: 10 } };
const usd = (inputTokens: number, outputTokens: number) => (inputTokens * 1 + outputTokens * 10) / 1_000_000;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetUnpricedWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  Usage.configure({ pricing: undefined });
  warn.mockRestore();
});

describe("withCost", () => {
  test("no pricing: no costUsd at all; a pricing function: null, not its unit", () => {
    expect(withCost("fake", usage(10, 1))).not.toHaveProperty("costUsd");
    // A pricing function's unit is the app's, not known to be USD, and a run
    // mixing it with table-priced calls must not add up to a partial number.
    Usage.configure({ pricing: () => 5 });
    expect(withCost("fake", usage(10, 1)).costUsd).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("cache reads without a cachedInput price are null, warned once; with one, priced", () => {
    const read = usage(1_000_000, 0, { cachedInputTokens: 500_000 });
    Usage.configure({ pricing: { m: { input: 2, output: 0 } } });
    expect(withCost("m", read).costUsd).toBeNull();
    expect(withCost("m", read).costUsd).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("cachedInput");
    // No cache reads: priced at input.
    expect(withCost("m", usage(1_000_000, 0)).costUsd).toBe(2);
    Usage.configure({ pricing: { m: { input: 2, output: 0, cachedInput: 0.2 } } });
    expect(withCost("m", read).costUsd).toBeCloseTo(1 + 0.1);
  });

  test("cache writes need a cacheWriteInput price or the provider's factor", () => {
    const written = usage(1_000_000, 0, { cacheWriteInputTokens: 1_000_000 });
    Usage.configure({ pricing: { m: { input: 2, output: 0 } } });
    expect(withCost("m", written).costUsd).toBeNull();
    expect(withCost("m", written, 1.25).costUsd).toBe(2.5);
    Usage.configure({ pricing: { m: { input: 2, output: 0, cacheWriteInput: 3 } } });
    expect(withCost("m", written).costUsd).toBe(3);
  });

  test("the warning goes to the given log rather than the console", () => {
    Usage.configure({ pricing: prices });
    const log = vi.fn();
    expect(withCost("mystery", usage(1, 1), undefined, log).costUsd).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a priced model gets its cost; an unknown one null, warned once", () => {
    Usage.configure({ pricing: prices });
    expect(withCost("fake", usage(1000, 100)).costUsd).toBeCloseTo(usd(1000, 100));
    expect(withCost("mystery", usage(1000, 100)).costUsd).toBeNull();
    expect(withCost("mystery", usage(5, 5)).costUsd).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('"mystery"');
  });

  test("the innermost meter's table wins over the configured one", async () => {
    Usage.configure({ pricing: prices });
    const inner = await Usage.meter(() => withCost("fake", usage(1_000_000, 0)), {
      pricing: { fake: { input: 3, output: 0 } },
    });
    expect(inner.value.costUsd).toBe(3);
  });
});

describe("summing", () => {
  test("costs add up, absent adds nothing, and null wins", () => {
    const a = usage(1, 1, { costUsd: 0.25 });
    const b = usage(1, 1, { costUsd: 0.5 });
    expect(addUsage(a, b).costUsd).toBe(0.75);
    expect(addUsage(a, usage(1, 1)).costUsd).toBe(0.25);
    expect(addUsage(usage(1, 1), usage(1, 1))).not.toHaveProperty("costUsd");
    expect(addUsage(a, usage(1, 1, { costUsd: null })).costUsd).toBeNull();
    expect(addUsage(usage(1, 1, { costUsd: null }), b).costUsd).toBeNull();
  });
});

describe("cache writes, per provider", () => {
  const written = usage(1_000_000, 0, { cacheWriteInputTokens: 1_000_000 });

  test("Anthropic bills writes at 1.25x input; others at input", () => {
    const anthropic = new AnthropicProvider("claude-test", { apiKey: "k" });
    const openai = new OpenAIProvider("gpt-test", { apiKey: "k" });
    expect(anthropic.cacheWriteFactor("claude-test")).toBe(1.25);
    // OpenAI reports no cache writes, and states no rule for them.
    expect(openai.cacheWriteFactor?.("gpt-test")).toBeUndefined();
    expect(priceUsage({ m: { input: 2, output: 0 } }, "m", written, 1.25)).toBe(2.5);
    // A meter keeps its long-standing default: writes at input.
    expect(priceUsage({ m: { input: 2, output: 0 } }, "m", written)).toBe(2);
  });

  test("an explicit cacheWriteInput wins over the factor", () => {
    expect(priceUsage({ m: { input: 2, output: 0, cacheWriteInput: 4 } }, "m", written, 1.25)).toBe(4);
  });

  test("a fallback chain asks the leg that served the model", () => {
    const chain = new FallbackProvider([
      { provider: new OpenAIProvider("gpt-test", { apiKey: "k" }) },
      { provider: new AnthropicProvider("claude-test", { apiKey: "k" }) },
    ]);
    expect(chain.cacheWriteFactor("claude-test")).toBe(1.25);
    expect(chain.cacheWriteFactor("claude-test-20260101")).toBe(1.25);
    expect(chain.cacheWriteFactor("gpt-test")).toBeUndefined();
    expect(chain.cacheWriteFactor("unknown")).toBeUndefined();
  });

  test("an agent's calls use their provider's factor, in costUsd and in meters", async () => {
    Usage.configure({ pricing: { fake: { input: 2, output: 0 } } });
    const provider = Object.assign(
      fakeProvider([
        { type: "text-delta", delta: "hi" },
        { ...finish(1_000_000, 0), usage: { ...written } },
      ]),
      { cacheWriteFactor: () => 1.25 },
    );
    const agent = Agent.create({ name: "a", provider });
    const metered = await Usage.meter(() => agent.stream({ messages: [] }).result());
    expect(metered.value.usage.costUsd).toBe(2.5);
    expect(metered.cost).toBe(2.5);
  });
});

const toolCall = (id: string, name: string) => ({ type: "tool-call" as const, id, name, args: "{}" });

describe("a run's costUsd", () => {

  async function run(onUsage?: (report: UsageReport) => void) {
    const sub = Agent.create({
      name: "sub",
      provider: fakeProvider([{ type: "text-delta", delta: "ok" }, finish(1000, 10)]),
    });
    const review = AgentTool.create({
      name: "review",
      description: "x",
      inputSchema: s.object({}),
      outputSchema: s.object({ ok: s.boolean() }),
      execute: async (_input: unknown, ctx: ToolContext) => {
        const judged = await ctx.generate({
          provider: fakeProvider([{ type: "output-delta", delta: '{"ok":true}' }, finish(100, 1)]),
          prompt: "x",
          output: s.object({ ok: s.boolean() }),
        });
        expect(judged.usage.costUsd).toBeCloseTo(usd(100, 1));
        await ctx.runAgent(sub, { prompt: "go" });
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
    const stream = agent.stream({
      messages: [],
      ...(onUsage ? { usageLimits: { onUsage } } : {}),
    });
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    return { result: await stream.result(), events };
  }

  test("is every call's cost: its steps, its tools' generates and sub-runs", async () => {
    Usage.configure({ pricing: prices });
    const { result } = await run();
    expect(result.usage.costUsd).toBeCloseTo(usd(10, 1) + usd(100, 1) + usd(1000, 10) + usd(20, 2));
  });

  test("never reaches a client frame or a stored message", async () => {
    Usage.configure({ pricing: prices });
    const { result, events } = await run();
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("costUsd");
    // The messages a store keeps, the sub-run's transcript on the tool part included.
    expect(JSON.stringify(result.messages)).not.toContain("costUsd");
    expect(JSON.stringify(result.messages)).toContain('"usage"');
  });

  test("onUsage hears it as delta and total", async () => {
    Usage.configure({ pricing: prices });
    const reports: UsageReport[] = [];
    const { result } = await run((report) => void reports.push(report));
    const final = reports.at(-1)!;
    expect(final.final).toBe(true);
    expect(final.costUsd!.total).toBeCloseTo(result.usage.costUsd!);
    const deltas = reports.reduce((sum, report) => sum + (report.costUsd?.delta ?? 0), 0);
    expect(deltas).toBeCloseTo(result.usage.costUsd!);
  });

  test("a fallback chain's finish prices each leg at its own model", async () => {
    Usage.configure({ pricing: { a: { input: 1, output: 0 }, b: { input: 100, output: 0 } } });
    const leg = (model: string, events: any[]) =>
      Object.assign(fakeProvider(events), { model }) as unknown as ReturnType<typeof fakeProvider>;
    const chain = FallbackProvider.chain([
      {
        provider: leg("a", [
          { type: "error", error: { code: "rate_limited", message: "busy", retryable: true } },
          { type: "finish", reason: "error", usage: usage(1_000_000, 0) },
        ]),
      },
      { provider: leg("b", [{ type: "text-delta", delta: "ok" }, finish(10_000, 0)]) },
    ]);
    const agent = Agent.create({ name: "a", provider: chain });
    const metered = await Usage.meter(() => agent.stream({ messages: [] }).result());
    // The abandoned leg at a's price ($1), the answer at b's ($1), not all at b's ($101).
    expect(metered.value.usage.costUsd).toBeCloseTo(2);
    expect(metered.byModel.a!.cost).toBeCloseTo(1);
    expect(metered.byModel.b!.cost).toBeCloseTo(1);
  });

  test("mixing table-priced calls with a meter's pricing function gives null", async () => {
    Usage.configure({ pricing: prices });
    const sub = Agent.create({
      name: "sub",
      provider: fakeProvider([{ type: "text-delta", delta: "ok" }, finish(10, 1)]),
    });
    const tool = AgentTool.create({
      name: "inner",
      description: "x",
      inputSchema: s.object({}),
      outputSchema: s.object({ ok: s.boolean() }),
      execute: async (_input: unknown, ctx: ToolContext) => {
        await Usage.meter(() => ctx.runAgent(sub, { prompt: "go" }), { pricing: () => 7 });
        return { ok: true };
      },
    });
    const agent = Agent.create({
      name: "lead",
      provider: fakeProvider(
        [toolCall("c1", "inner"), finish(10, 1)],
        [{ type: "text-delta", delta: "done" }, finish(20, 2)],
      ),
      tools: [tool],
    });
    expect((await agent.stream({ messages: [] }).result()).usage.costUsd).toBeNull();
  });

  test("an image a tool generates is priced on the run, and its record on the call carries no cost", async () => {
    Usage.configure({ pricing: { ...prices, "fake-image": { input: 5, output: 10 } } });
    const banner = ImageModel.create({ name: "banner", provider: fakeImageProvider(), size: "1024x1024" });
    const draw = AgentTool.create({
      name: "draw",
      description: "x",
      inputSchema: s.object({}),
      outputSchema: s.object({ id: s.string() }),
      execute: async (_input: unknown, ctx: any) => {
        const made = await ctx.generateImage(banner, { prompt: "a street" });
        expect(made.usage.costUsd).toBeGreaterThan(0);
        return { id: made.attachment.id };
      },
    });
    const storage = {
      objects: new Map<string, Blob>(),
      async put(params: any) {
        const name = `blob-${this.objects.size}`;
        this.objects.set(name, params instanceof Blob ? params : params.body);
        return name;
      },
    };
    const attachments = new ScopedAttachments(new MemoryAttachmentStore(), storage as any, { key: "user:u1" });
    const agent = Agent.create({
      name: "designer",
      provider: fakeProvider([toolCall("c1", "draw"), finish(10, 1)], [{ type: "text-delta", delta: "done" }, finish(20, 2)]),
      tools: [draw],
    });
    const stream = agent.stream({ messages: [], attachments });
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.usage.costUsd).toBeCloseTo(usd(10, 1) + usd(20, 2) + (15 * 5 + 196 * 10) / 1_000_000);
    expect(JSON.stringify(result.messages)).toContain('"generated"');
    expect(JSON.stringify(result.messages)).not.toContain("costUsd");
    expect(JSON.stringify(events)).not.toContain("costUsd");
  });

  test("is null with an unpriced call in it, and absent with no table", async () => {
    Usage.configure({ pricing: { other: { input: 1, output: 1 } } });
    expect((await run()).result.usage.costUsd).toBeNull();
    Usage.configure({ pricing: undefined });
    const { result } = await run();
    expect(result.usage).not.toHaveProperty("costUsd");
  });
});

describe("images", () => {
  test("a generated image's usage carries its cost", async () => {
    Usage.configure({ pricing: { "fake-image": { input: 5, output: 10, imageOutput: 30 } } });
    const model = ImageModel.create({ name: "banner", provider: fakeImageProvider() });
    const image = await model.generate({ prompt: "a street" });
    expect(image.usage.costUsd).toBeCloseTo((15 * 5 + 196 * 30) / 1_000_000);
  });

  test("an unpriced image model is null", async () => {
    Usage.configure({ pricing: { "gpt-test": { input: 1, output: 1 } } });
    const model = ImageModel.create({ name: "banner", provider: fakeImageProvider() });
    expect((await model.generate({ prompt: "a street" })).usage.costUsd).toBeNull();
  });
});

describe("generate", () => {
  test("its usage carries the call's cost", async () => {
    Usage.configure({ pricing: prices });
    const result = await generate({
      provider: fakeProvider([{ type: "output-delta", delta: '{"ok":true}' }, finish(100, 1)]),
      prompt: "x",
      output: s.object({ ok: s.boolean() }),
    });
    expect(result.usage.costUsd).toBeCloseTo(usd(100, 1));
  });
});
