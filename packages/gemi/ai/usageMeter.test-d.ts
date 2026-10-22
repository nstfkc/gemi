import { describe, expectTypeOf, test } from "vitest";
import type { AgentRunResult, ToolContext } from "./Agent";
import {
  Usage,
  type MeteredUsage,
  type ModelPrice,
  type Usage as UsageType,
  type UsageLine,
  type UsageMeter,
  type UsagePricing,
  type UsageTotals,
} from "./index";
import type { ToolShapes } from "./types";

describe("Usage, the type and the value (#1021)", () => {
  test("the type is still the token usage", () => {
    const usage: UsageType = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    expectTypeOf(usage.cachedInputTokens).toEqualTypeOf<number | undefined>();
    // @ts-expect-error — a usage needs its token counts
    const bad: Usage = { inputTokens: 1 };
    void bad;
  });

  test("meter answers the function's value with the totals", async () => {
    const metered = await Usage.meter(async (meter) => {
      expectTypeOf(meter).toEqualTypeOf<UsageMeter>();
      meter.add("browser", 1);
      return { id: 1 };
    });
    expectTypeOf(metered).toEqualTypeOf<MeteredUsage<{ id: number }>>();
    expectTypeOf(metered.value.id).toBeNumber();
    expectTypeOf(metered.cost).toBeNumber();
    expectTypeOf(metered.byModel).toEqualTypeOf<Record<string, UsageLine>>();
    expectTypeOf(metered.byLabel).toEqualTypeOf<Record<string, UsageLine>>();
    expectTypeOf(metered.unpriced).toEqualTypeOf<string[]>();

    const sync = await Usage.meter(() => "x", { label: "critique" });
    expectTypeOf(sync.value).toBeString();
  });

  test("pricing is a table of ModelPrice or a function", () => {
    const table: UsagePricing = { "gpt-5.4": { input: 1.25, output: 10 } satisfies ModelPrice };
    const fn: UsagePricing = (model, usage) => (model === "x" ? usage.inputTokens : undefined);
    Usage.configure({ pricing: table });
    Usage.configure({ pricing: fn });
    Usage.configure({ pricing: undefined });
    // @ts-expect-error — a price needs input and output
    Usage.configure({ pricing: { "gpt-5.4": { input: 1 } } });
    // @ts-expect-error — the function answers a number
    Usage.configure({ pricing: () => "free" });
  });

  test("add, record and current", () => {
    expectTypeOf(Usage.add).parameters.toEqualTypeOf<[label: string, cost: number]>();
    expectTypeOf(Usage.record).parameters.toEqualTypeOf<[model: string, usage: UsageType]>();
    expectTypeOf(Usage.current()).toEqualTypeOf<UsageMeter | undefined>();
  });

  test("a tool has the run's meter, and a result its totals", () => {
    expectTypeOf<ToolContext["meter"]>().toEqualTypeOf<UsageMeter>();
    expectTypeOf<AgentRunResult<ToolShapes, unknown>["metered"]>().toEqualTypeOf<
      UsageTotals | undefined
    >();
    // Optional, so a result built by hand still typechecks.
    const stub: AgentRunResult<ToolShapes, unknown> = {
      runId: "r",
      messages: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    void stub;
  });
});
