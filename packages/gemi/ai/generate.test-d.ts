/**
 * Type-level tests for `generate` and `ctx.generate`.
 *
 * The output inferred from the schema, which a runtime test cannot see. Run
 * with `bun run test:types`.
 *
 * `ok` narrowing `output` and `error` is NOT here: this package compiles
 * without `strictNullChecks`, under which there is no `undefined` to narrow
 * away and the claim cannot fail. It is held down in a strict program instead —
 * `__fixtures__/generate/narrowing.ts`, compiled by `generate.test.ts`.
 */
import { describe, expectTypeOf, test } from "vitest";

import { AgentTool, type ToolContext } from "./Agent";
import { OpenAIProvider } from "./AgentProvider";
import { generate, type GenerateResult, type GenerateSuccess } from "./generate";
import type { AgentRunFailure } from "./Agent";
import { s, type JsonValue } from "./Schema";
import type { AgentMessage, FinishReason, Usage } from "./types";

const provider = OpenAIProvider.model("gpt-5.4");
const output = s.object({
  copies: s.array(s.object({ headline: s.string(), cta: s.string().optional() })),
});
type Copies = { copies: { headline: string; cta?: string }[] };

describe("generate", () => {
  test("the output is typed by the schema", async () => {
    const result = await generate({ provider, prompt: "go", output });
    expectTypeOf(result).toEqualTypeOf<GenerateResult<Copies>>();
  });

  test("messages, usage and finishReason are on both arms", async () => {
    const result = await generate({ provider, prompt: "go", output });
    expectTypeOf(result.messages).toEqualTypeOf<AgentMessage[]>();
    expectTypeOf(result.usage).toEqualTypeOf<Usage>();
    expectTypeOf(result.finishReason).toEqualTypeOf<FinishReason>();
  });

  test("a non-strict s.json() schema types as JSON", async () => {
    const result = await generate({
      provider,
      prompt: "go",
      output: s.object({ state: s.json(), components: s.json() }),
    });
    if (result.ok) {
      expectTypeOf(result.output).toEqualTypeOf<{ state: JsonValue; components: JsonValue }>();
    }
  });

  test("throwOnError: true resolves only the ok: true arm", async () => {
    const result = await generate({ provider, prompt: "go", output, throwOnError: true });
    expectTypeOf(result).toEqualTypeOf<GenerateSuccess<Copies>>();
    expectTypeOf(result.output).toEqualTypeOf<Copies>();
  });

  test("throwOnError: false, or a boolean, keeps both arms", async () => {
    const flag = Math.random() > 0.5;
    expectTypeOf(
      await generate({ provider, prompt: "go", output, throwOnError: false }),
    ).toEqualTypeOf<GenerateResult<Copies>>();
    expectTypeOf(
      await generate({ provider, prompt: "go", output, throwOnError: flag }),
    ).toEqualTypeOf<GenerateResult<Copies>>();
  });

  test("a failure's error carries the status and request id", async () => {
    const result = await generate({ provider, prompt: "go", output });
    if (!result.ok) expectTypeOf(result.error).toEqualTypeOf<AgentRunFailure>();
  });

  test("the output schema is required", () => {
    // @ts-expect-error — no `output`
    void generate({ provider, prompt: "go" });
  });
});

describe("ctx.generate", () => {
  test("is typed like generate", () => {
    AgentTool.create({
      name: "write",
      description: "x",
      inputSchema: s.object({}),
      execute: async (_input, ctx) => {
        const result = await ctx.generate({ provider, prompt: "go", output });
        expectTypeOf(result).toEqualTypeOf<GenerateResult<Copies>>();
        if (!result.ok) return result.error.message;
        expectTypeOf(result.output.copies[0].headline).toEqualTypeOf<string>();
        return "ok";
      },
    });
  });

  test("narrows with throwOnError: true, like generate", () => {
    AgentTool.create({
      name: "write",
      description: "x",
      inputSchema: s.object({}),
      execute: async (_input, ctx) => {
        const result = await ctx.generate({ provider, prompt: "go", output, throwOnError: true });
        expectTypeOf(result).toEqualTypeOf<GenerateSuccess<Copies>>();
        return "ok";
      },
    });
  });

  test("takes a signal of its own", () => {
    expectTypeOf<Parameters<ToolContext["generate"]>[0]["signal"]>().toEqualTypeOf<
      AbortSignal | undefined
    >();
  });
});
