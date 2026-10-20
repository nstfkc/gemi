import { describe, expect, test } from "vitest";
import { Agent } from "./Agent";
import { generate } from "./generate";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import { measureUsage } from "./usageMeter";

const finish = (inputTokens: number, outputTokens: number, model?: string) => ({
  type: "finish" as const,
  reason: "stop" as const,
  usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  ...(model ? { model } : {}),
});

describe("measureUsage", () => {
  test("sums every model call inside, by model, however deep", async () => {
    const agentProvider = fakeProvider([{ type: "text-delta", delta: "hi" }, finish(100, 10, "gpt-x-2026")]);
    const judgeProvider = fakeProvider([{ type: "output-delta", delta: '{"ok":true}' }, finish(20, 2)]);
    const agent = Agent.create({ name: "a", provider: agentProvider });

    const measured = await measureUsage(async () => {
      await agent.stream({ messages: [] }).result();
      // A call made from nested app code, not handed anything.
      await (async () =>
        generate({ provider: judgeProvider, prompt: "x", output: s.object({ ok: s.boolean() }) }))();
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
    const call = () => generate({ provider: provider(), prompt: "x", output: s.object({ ok: s.boolean() }) });

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
