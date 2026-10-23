process.env.SECRET ??= "agent-test-secret";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Agent, AgentRunError, AgentTool } from "./Agent";
import type { AgentProvider, ProviderEvent, ProviderStreamParams } from "./AgentProvider";
import { generate, type GenerateAttempt } from "./generate";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, Usage } from "./types";

// `generate` with `validate` / `attempts`: the repair loop (#1017).

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

const answer = (value: unknown, spent = usage(10, 5)): ProviderEvent[] => [
  { type: "output-delta", delta: JSON.stringify(value) },
  { type: "finish", reason: "stop", usage: spent },
];

const broken = (spent = usage(10, 5)): ProviderEvent[] => [
  { type: "output-delta", delta: '{"headline": 1}' },
  { type: "finish", reason: "stop", usage: spent },
];

const cutOff = (spent = usage(10, 5)): ProviderEvent[] => [
  { type: "output-delta", delta: '{"headline": "a very long' },
  { type: "finish", reason: "length", usage: spent },
];

const failed = (retryable: boolean, extra: Record<string, unknown> = {}): ProviderEvent[] => [
  {
    type: "error",
    error: {
      code: retryable ? "rate_limited" : "content_filtered",
      message: retryable ? "Slow down." : "Refused.",
      retryable,
      ...extra,
    },
  } as ProviderEvent,
  { type: "finish", reason: "error", usage: usage(1, 0) },
];

const COPY = s.object({ headline: s.string(), cta: s.string() });

/** The text of each user turn a call was sent, in order. */
const userTexts = (call: ProviderStreamParams) =>
  call.messages
    .filter((m: AgentMessage) => m.role === "user")
    .map((m) => m.content.map((part: any) => part.text).join(""));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Answers `answers` in order; an entry of `"hang"` starts a call and never
 * answers it (ignoring its signal), the run-on an `attemptTimeoutMs` exists for.
 */
function scripted(...answers: (ProviderEvent[] | "hang")[]) {
  const base = fakeProvider();
  const calls: ProviderStreamParams[] = [];
  const provider = {
    model: "scripted",
    capabilities: base.capabilities,
    calls,
    stream(params: ProviderStreamParams) {
      calls.push(params);
      const script = answers[calls.length - 1] ?? answer({ headline: "?", cta: "?" });
      if (script === "hang") {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<ProviderEvent>>(() => {}),
          }),
        };
      }
      return (async function* () {
        for (const event of script) yield event;
      })();
    },
    upload: async () => "file",
    normalizeError: base.normalizeError.bind(base),
  };
  return provider as unknown as AgentProvider & { calls: ProviderStreamParams[] };
}

/**
 * Resolves once `signal` has aborted, including when it already had. An
 * `abort` listener added after the fact never fires: on a slow runner the 30 ms
 * deadline could pass before `validate` was called, and the test hung (#1037).
 */
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

describe("generate with validate", () => {
  test("without validate or attempts it is one call, as before", async () => {
    const provider = scripted(broken(), answer({ headline: "h", cta: "c" }));
    const result = await generate({ provider, prompt: "go", output: COPY });

    expect(provider.calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.attemptLog).toHaveLength(1);
    expect(result.attemptLog[0]).toMatchObject({ attempt: 1, outcome: "invalid_output" });
  });

  test("a passing answer is returned at once, with one attempt", async () => {
    const provider = scripted(answer({ headline: "h", cta: "c" }));
    const validate = vi.fn(() => []);
    const result = await generate({ provider, prompt: "go", output: COPY, validate });

    expect(result).toMatchObject({ ok: true, output: { headline: "h", cta: "c" }, attempts: 1 });
    expect(provider.calls).toHaveLength(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0]).toMatchObject([
      { headline: "h", cta: "c" },
      { attempt: 1, attempts: 3 },
    ]);
  });

  test("a rejected answer is corrected in the same conversation, and the usage summed", async () => {
    const provider = scripted(
      answer({ headline: "", cta: "c" }, usage(100, 10)),
      answer({ headline: "Bread", cta: "c" }, usage(150, 12)),
    );
    const result = await generate({
      provider,
      prompt: "A bakery.",
      output: COPY,
      validate: (copy) => [!copy.headline && "The headline is empty.", null, false],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ headline: "Bread", cta: "c" });
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual(usage(250, 22));
    expect(result.attemptLog.map((a) => [a.outcome, a.usage.totalTokens])).toEqual([
      ["rejected", 110],
      ["passed", 162],
    ]);
    expect(result.attemptLog[0].problems).toEqual(["The headline is empty."]);
    // The second call continues the first: the prompt, the rejected reply, the
    // feedback.
    const second = provider.calls[1];
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(userTexts(second)[1]).toContain("- The headline is empty.");
    // The passing transcript is the one returned.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("feedback writes the next prompt, and is told why", async () => {
    const provider = scripted(
      answer({ headline: "", cta: "c" }),
      answer({ headline: "h", cta: "c" }),
    );
    const feedback = vi.fn((problems: string[]) => `FIX: ${problems.join(" / ")}`);
    await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: (copy) => [!copy.headline && "empty"],
      feedback,
    });

    expect(feedback).toHaveBeenCalledWith(["empty"], {
      attempt: 1,
      attempts: 3,
      cause: "rejected",
      restart: false,
    });
    expect(userTexts(provider.calls[1])[1]).toBe("FIX: empty");
  });

  test("{ ok: true, value } passes and replaces the output (async, too)", async () => {
    const provider = scripted(answer({ headline: "h", cta: "c" }));
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: async (copy) => ({ ok: true as const, value: copy.headline.length }),
    });

    expect(result.ok && result.output).toBe(1);
  });

  test("gives up after `attempts`, returning the last rejected answer rather than throwing", async () => {
    const provider = scripted(
      answer({ headline: "a", cta: "c" }),
      answer({ headline: "b", cta: "c" }),
      answer({ headline: "c", cta: "c" }),
    );
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: (copy) => ({ ok: false as const, problems: [`"${copy.headline}" is too short.`] }),
      logErrors: false,
    });

    expect(provider.calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toMatchObject({ code: "invalid_output", retryable: true });
    expect(result.error!.message).toContain("rejected 3 times");
    expect(result.error!.message).toContain('- "c" is too short.');
    expect(result.rejected).toEqual({
      output: { headline: "c", cta: "c" },
      problems: ['"c" is too short.'],
    });
  });

  test("throwOnError throws an AgentRunError carrying the rejected answer", async () => {
    const provider = scripted(
      answer({ headline: "a", cta: "c" }),
      answer({ headline: "b", cta: "c" }),
    );
    const error = await generate({
      provider,
      prompt: "go",
      output: COPY,
      attempts: 2,
      validate: () => ["no"],
      throwOnError: true,
      logErrors: false,
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentRunError);
    expect(error.code).toBe("invalid_output");
    expect(error.rejected).toEqual({ output: { headline: "b", cta: "c" }, problems: ["no"] });
    expect(error.result.usage).toEqual(usage(20, 10));
  });

  test("retry: false stops at once", async () => {
    const provider = scripted(answer({ headline: "rewrite", cta: "c" }));
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: () => ({
        ok: false as const,
        problems: ["The model declined."],
        retry: false as const,
      }),
      logErrors: false,
    });

    expect(provider.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, attempts: 1, error: { retryable: false } });
  });

  test("retry: 'restart' drops the reply and asks the same request again with a note", async () => {
    const provider = scripted(
      answer({ headline: "a", cta: "c" }),
      answer({ headline: "b", cta: "c" }),
      answer({ headline: "ok", cta: "c" }),
    );
    await generate({
      provider,
      prompt: "REQUEST",
      output: COPY,
      validate: (copy) =>
        copy.headline === "ok"
          ? []
          : { ok: false as const, problems: [`lost ${copy.headline}`], retry: "restart" as const },
      feedback: (problems, { restart }) => `${restart ? "NOTE" : "FIX"}: ${problems[0]}`,
    });

    expect(provider.calls[1].messages).toHaveLength(1);
    expect(userTexts(provider.calls[1])).toEqual(["REQUEST\n\nNOTE: lost a"]);
    // A second restart replaces the note rather than stacking it.
    expect(userTexts(provider.calls[2])).toEqual(["REQUEST\n\nNOTE: lost b"]);
  });

  test("a restart after a continue keeps the corrected conversation", async () => {
    const provider = scripted(
      answer({ headline: "a", cta: "c" }),
      answer({ headline: "b", cta: "c" }),
      answer({ headline: "ok", cta: "c" }),
    );
    await generate({
      provider,
      prompt: "REQUEST",
      output: COPY,
      validate: (copy) =>
        copy.headline === "a"
          ? ["fix a"]
          : copy.headline === "b"
            ? { ok: false as const, problems: ["lost b"], retry: "restart" as const }
            : [],
      feedback: (problems, { restart }) => `${restart ? "NOTE" : "FIX"}: ${problems[0]}`,
    });

    expect(userTexts(provider.calls[2])).toEqual(["REQUEST", "FIX: fix a\n\nNOTE: lost b"]);
  });

  test("a validate that throws rejects the call", async () => {
    const provider = scripted(answer({ headline: "a", cta: "c" }));
    await expect(
      generate({
        provider,
        prompt: "go",
        output: COPY,
        validate: () => {
          throw new Error("bug");
        },
      }),
    ).rejects.toThrow("bug");
  });
});

describe("a schema mismatch inside the loop", () => {
  test("continues with the parse error by default", async () => {
    const provider = scripted(broken(), answer({ headline: "h", cta: "c" }));
    const result = await generate({ provider, prompt: "go", output: COPY, attempts: 3 });

    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(result.attemptLog[0].outcome).toBe("invalid_output");
    expect(provider.calls[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(userTexts(provider.calls[1])[1]).toContain("does not match the output schema");
  });

  test("onInvalidOutput: 'restart' asks again without the broken reply", async () => {
    const provider = scripted(broken(), answer({ headline: "h", cta: "c" }));
    await generate({
      provider,
      prompt: "go",
      output: COPY,
      attempts: 2,
      onInvalidOutput: "restart",
    });

    expect(provider.calls[1].messages).toHaveLength(1);
  });

  test("onInvalidOutput: 'fail' ends the loop with the schema error", async () => {
    const provider = scripted(broken(), answer({ headline: "h", cta: "c" }));
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: () => [],
      onInvalidOutput: "fail",
      logErrors: false,
    });

    expect(provider.calls).toHaveLength(1);
    expect(result.error?.code).toBe("invalid_output");
  });

  test("a cut-off answer is always asked again as a restart", async () => {
    const provider = scripted(cutOff(), answer({ headline: "h", cta: "c" }));
    const feedback = vi.fn(() => "SHORTER");
    const result = await generate({ provider, prompt: "go", output: COPY, attempts: 2, feedback });

    expect(result.attemptLog[0]).toMatchObject({ outcome: "cut_off", finishReason: "length" });
    expect(feedback.mock.calls[0][1]).toMatchObject({ cause: "cut_off", restart: true });
    expect(userTexts(provider.calls[1])).toEqual(["go\n\nSHORTER"]);
  });

  test("the last attempt's schema error is the result's", async () => {
    const provider = scripted(broken(), broken());
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      attempts: 2,
      logErrors: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_output");
    expect(result.rejected).toBeUndefined();
  });
});

describe("provider errors inside the loop", () => {
  test("a retryable error is asked again unchanged", async () => {
    const provider = scripted(failed(true), answer({ headline: "h", cta: "c" }));
    const result = await generate({ provider, prompt: "go", output: COPY, validate: () => [] });

    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(result.attemptLog[0]).toMatchObject({
      outcome: "error",
      error: { code: "rate_limited" },
    });
    expect(userTexts(provider.calls[1])).toEqual(["go"]);
  });

  test("waits the provider's retryAfter first", async () => {
    const provider = scripted(
      failed(true, { retryAfter: 60 }),
      answer({ headline: "h", cta: "c" }),
    );
    const started = Date.now();
    await generate({ provider, prompt: "go", output: COPY, validate: () => [] });

    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  test("retryErrors: false ends on the first error", async () => {
    const provider = scripted(failed(true), answer({ headline: "h", cta: "c" }));
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: () => [],
      retryErrors: false,
      logErrors: false,
    });

    expect(provider.calls).toHaveLength(1);
    expect(result.error?.code).toBe("rate_limited");
  });

  test("a non-retryable error ends the loop, keeping the last rejected answer", async () => {
    const provider = scripted(answer({ headline: "a", cta: "c" }), failed(false));
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: () => ["no"],
      logErrors: false,
    });

    expect(provider.calls).toHaveLength(2);
    expect(result.error?.code).toBe("content_filtered");
    expect(result.rejected).toEqual({ output: { headline: "a", cta: "c" }, problems: ["no"] });
  });
});

describe("timeouts and abort", () => {
  test("attemptTimeoutMs stops a run-on attempt and asks again", async () => {
    const provider = scripted("hang", answer({ headline: "h", cta: "c" }));
    const feedback = vi.fn(() => "AGAIN");
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      attempts: 2,
      attemptTimeoutMs: 20,
      feedback,
    });

    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(result.attemptLog[0]).toMatchObject({ outcome: "timeout", error: { code: "timeout" } });
    expect(feedback.mock.calls[0][1]).toMatchObject({ cause: "timeout", restart: true });
    expect(userTexts(provider.calls[1])).toEqual(["go\n\nAGAIN"]);
  });

  test("timeoutMs bounds every attempt together and is not retried", async () => {
    const provider = scripted("hang", "hang", "hang");
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: () => [],
      timeoutMs: 30,
      logErrors: false,
    });

    expect(provider.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" }, attempts: 1 });
  });

  test("timeoutMs counts validation, and the next attempt is not made", async () => {
    const provider = scripted(
      answer({ headline: "a", cta: "c" }),
      answer({ headline: "b", cta: "c" }),
    );
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      timeoutMs: 30,
      validate: async (_copy, { signal }) => {
        await untilAborted(signal);
        return ["late"];
      },
      logErrors: false,
    });

    expect(provider.calls).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "timeout" },
      finishReason: "aborted",
    });
    expect(result.rejected?.problems).toEqual(["late"]);
  });

  test("a deadline that passed before validation starts still ends the loop", async () => {
    // The order a slow runner produced in #1037: the answer arrives, and the
    // deadline is already gone by the time `validate` is called.
    const provider = scripted(
      answer({ headline: "a", cta: "c" }),
      answer({ headline: "b", cta: "c" }),
    );
    const seen: boolean[] = [];
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      timeoutMs: 30,
      validate: async (_copy, { signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        seen.push(signal.aborted);
        await untilAborted(signal);
        return ["late"];
      },
      logErrors: false,
    });

    expect(seen).toEqual([true]);
    expect(provider.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(result.rejected?.problems).toEqual(["late"]);
  });

  test("an abort stops the loop with code aborted, and is not logged", async () => {
    const provider = scripted("hang");
    const controller = new AbortController();
    const pending = generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: () => [],
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(provider.calls).toHaveLength(1);
    expect(result.error?.code).toBe("aborted");
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("reporting", () => {
  test("onAttempt hears each attempt with its duration and usage", async () => {
    const provider = scripted(
      answer({ headline: "", cta: "c" }, usage(3, 1)),
      answer({ headline: "h", cta: "c" }, usage(4, 2)),
    );
    const heard: GenerateAttempt[] = [];
    const result = await generate({
      provider,
      prompt: "go",
      output: COPY,
      validate: (copy) => [!copy.headline && "empty"],
      onAttempt: (attempt) => heard.push({ ...attempt }),
    });

    expect(heard.map((a) => [a.attempt, a.outcome, a.usage.totalTokens])).toEqual([
      [1, "rejected", 4],
      [2, "passed", 6],
    ]);
    expect(heard.every((a) => typeof a.durationMs === "number")).toBe(true);
    expect(result.attemptLog).toEqual(heard);
  });

  test("a loop that never passes is logged once", async () => {
    const provider = scripted(
      answer({ headline: "a", cta: "c" }),
      answer({ headline: "b", cta: "c" }),
    );
    await generate({ provider, prompt: "go", output: COPY, attempts: 2, validate: () => ["no"] });

    const logs = vi
      .mocked(console.error)
      .mock.calls.filter((call) => String(call[0]).includes("generate() failed"));
    expect(logs).toHaveLength(1);
    expect(String(logs[0][0])).toContain("invalid_output");
  });
});

describe("ctx.generate with validate", () => {
  test("adds the usage of every attempt to the turn's", async () => {
    const inner = scripted(
      answer({ headline: "", cta: "c" }, usage(7, 3)),
      answer({ headline: "h", cta: "c" }, usage(5, 5)),
    );
    let attempts = 0;
    const tool = AgentTool.create({
      name: "write",
      description: "x",
      inputSchema: s.object({}),
      execute: async (_input: any, ctx: any) => {
        const result = await ctx.generate({
          provider: inner,
          prompt: "go",
          output: COPY,
          validate: (copy: { headline: string }) => [!copy.headline && "empty"],
        });
        attempts = result.attempts;
        return result.ok ? result.output : null;
      },
    });
    const agent = Agent.create({
      name: "lead",
      provider: fakeProvider(
        [
          { type: "tool-call", toolCallId: "c1", name: "write", args: "{}" },
          { type: "finish", reason: "stop", usage: usage(100, 10) },
        ],
        [{ type: "finish", reason: "stop", usage: usage(200, 20) }],
      ),
      tools: [tool],
    });

    const result = await agent.stream({ messages: [] }).result();

    expect(attempts).toBe(2);
    // 100 + 200 from the parent's two steps, 7 + 5 and 3 + 5 from the attempts.
    expect(result.usage).toEqual(usage(312, 38));
  });
});
