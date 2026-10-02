process.env.SECRET ??= "agent-test-secret";

import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Agent, AgentRunError, AgentTool } from "./Agent";
import type { AgentProvider, ProviderEvent, ProviderStreamParams } from "./AgentProvider";
import { generate } from "./generate";
import { fakeProvider } from "./providers/fakeProvider";
import { toResponsesInput } from "./providers/request";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, Usage } from "./types";

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

const answer = (value: unknown, spent = usage(10, 5)): ProviderEvent[] => {
  const text = JSON.stringify(value);
  // Split, so the parse is of the accumulated text and not of one delta.
  return [
    { type: "output-delta", delta: text.slice(0, 7) },
    { type: "output-delta", delta: text.slice(7) },
    { type: "finish", reason: "stop", usage: spent },
  ];
};

const COPY = s.object({ headline: s.string(), cta: s.string() });

// A failed call is logged by default, and outside an application that is
// `console.error`. Silenced here; the logging tests read it.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
const generateLogs = () =>
  consoleError.mock.calls.filter((call) => String(call[0]).includes("generate() failed"));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A provider that starts a call and never answers it, and ignores its signal
 * while doing so — the uncooperative case the abort race exists for. `started`
 * resolves once the call is in flight.
 */
function hangingProvider() {
  const started = deferred();
  const calls: ProviderStreamParams[] = [];
  const provider = {
    model: "hang",
    capabilities: fakeProvider().capabilities,
    calls,
    started: started.promise,
    stream(params: ProviderStreamParams) {
      calls.push(params);
      return {
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<ProviderEvent>> => {
            started.resolve();
            return new Promise(() => {});
          },
        }),
      };
    },
    upload: async () => "file",
    normalizeError: (error: unknown) => ({
      code: "provider_error" as const,
      message: String(error),
      retryable: false,
    }),
  };
  return provider as unknown as AgentProvider & {
    calls: ProviderStreamParams[];
    started: Promise<void>;
  };
}

describe("generate", () => {
  test("returns the parsed output, the transcript and the usage", async () => {
    const provider = fakeProvider(
      answer({ headline: "Bread, daily", cta: "Order now" }, usage(120, 30)),
    );

    const result = await generate({
      provider,
      instructions: "You are a copywriter.",
      prompt: "A bakery.",
      output: COPY,
    });

    expect(result).toMatchObject({
      ok: true,
      output: { headline: "Bread, daily", cta: "Order now" },
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(result.error).toBeUndefined();
    // The prompt as a user turn, then the reply holding the value as an
    // `output` part — the same shape an agent's final turn has.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.messages[0].content).toEqual([{ type: "text", text: "A bakery." }]);
    expect(result.messages[1]).toMatchObject({
      finishReason: "stop",
      content: [{ type: "output", value: { headline: "Bread, daily", cta: "Order now" } }],
      // One call, one message: the reply carries the call's usage (#467).
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(result.messages[0].usage).toBeUndefined();
  });

  test("makes one call, with the schema, the system prompt and no tools", async () => {
    const provider = fakeProvider(answer({ headline: "h", cta: "c" }));

    await generate({
      provider,
      instructions: "Be brief.",
      prompt: "go",
      output: COPY,
      temperature: 0.2,
      maxOutputTokens: 4000,
      reasoning: "low",
    });

    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    expect(call.systemPrompt).toBe("Be brief.");
    expect(call.tools).toBeUndefined();
    expect(call.output).toEqual({
      name: "output",
      schema: COPY.toJSONSchema(),
      strict: true,
    });
    expect(call).toMatchObject({ temperature: 0.2, maxOutputTokens: 4000, reasoning: "low" });
  });

  test("sends a schema holding s.json() non-strict, and parses the free-form answer", async () => {
    const page = { state: { count: 0 }, components: { Hero: { render: ["div", {}, []] } } };
    const provider = fakeProvider(answer(page));

    const result = await generate({
      provider,
      prompt: "a page",
      output: s.object({ state: s.json(), components: s.json() }),
    });

    expect(provider.calls[0].output?.strict).toBe(false);
    expect(result.ok && result.output).toEqual(page);
  });

  test("continues prior messages, with the prompt appended as the next turn", async () => {
    const first = await generate({
      provider: fakeProvider(answer({ headline: "x" })),
      prompt: "first",
      output: COPY,
    });
    const provider = fakeProvider(answer({ headline: "h", cta: "c" }));

    const second = await generate({
      provider,
      messages: first.messages,
      prompt: "again",
      output: COPY,
    });

    // The provider saw the whole conversation, and the result hands it all
    // back — the prior messages untouched, at the front.
    expect(provider.calls[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages.slice(0, 2)).toEqual(first.messages);
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(second.ok).toBe(true);
  });

  test("accepts messages without a prompt, and refuses a call with neither", async () => {
    const seed: AgentMessage[] = [
      { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "" },
    ];
    const result = await generate({
      provider: fakeProvider(answer({ headline: "h", cta: "c" })),
      messages: seed,
      output: COPY,
    });
    expect(result.messages.map((m) => m.id)[0]).toBe("m1");
    expect(result.messages).toHaveLength(2);

    await expect(generate({ provider: fakeProvider(), output: COPY })).rejects.toThrow(
      /neither a `prompt` nor `messages`/,
    );
  });

  describe("an answer that does not match the schema", () => {
    const run = () =>
      generate({
        provider: fakeProvider(answer({ headline: 42 }, usage(50, 8))),
        prompt: "go",
        output: COPY,
      });

    test("returns ok: false with an invalid_output error, and does not throw", async () => {
      const result = await run();

      expect(result.ok).toBe(false);
      expect(result.output).toBeUndefined();
      expect(result.error).toMatchObject({ code: "invalid_output", retryable: true });
      expect(result.error?.message).toMatch(/did not match the output schema/);
      // The schema's own complaints, so a retry can quote them.
      expect(result.error?.message).toMatch(/headline/);
      expect(result.error?.message).toMatch(/cta/);
      expect(result.finishReason).toBe("stop");
    });

    test("still counts the usage — the tokens were billed", async () => {
      expect((await run()).usage).toEqual(usage(50, 8));
    });

    test("keeps the reply the model wrote, so a retry can continue from it", async () => {
      const result = await run();
      const reply = result.messages.at(-1)!;

      expect(reply.role).toBe("assistant");
      // As text, not as an `output` part: it is not a value of the schema.
      expect(reply.content).toEqual([{ type: "text", text: '{"headline":42}' }]);
      // And the retry really does show it to the model.
      const input = toResponsesInput(result.messages, fakeProvider().capabilities);
      expect(JSON.stringify(input.at(-1))).toContain('{\\"headline\\":42}');
    });

    test("an unparseable answer is reported the same way", async () => {
      const result = await generate({
        provider: fakeProvider([
          { type: "output-delta", delta: "not json at all" },
          { type: "finish", reason: "stop", usage: usage(1, 1) },
        ]),
        prompt: "go",
        output: COPY,
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_output");
      expect(result.messages.at(-1)!.content).toEqual([{ type: "text", text: "not json at all" }]);
    });
  });

  test("a cut-off answer is never parsed, even when the repaired half would pass", async () => {
    // `s.json()` accepts anything, so a repaired prefix passes it. That is the
    // trap: a half-written page returned as a finished one.
    const result = await generate({
      provider: fakeProvider([
        { type: "output-delta", delta: '{"state":{"a":1},"components":{"Hero":' },
        { type: "finish", reason: "length", usage: usage(10, 4000) },
      ]),
      prompt: "a page",
      output: s.object({ state: s.json(), components: s.json() }),
      maxOutputTokens: 4000,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.finishReason).toBe("length");
    expect(result.error).toMatchObject({ code: "invalid_output" });
    expect(result.error?.message).toMatch(/maxOutputTokens/);
    expect(result.usage.outputTokens).toBe(4000);
  });

  test("a reply with no structured answer at all is invalid_output, with the prose kept", async () => {
    const result = await generate({
      provider: fakeProvider([
        { type: "text-delta", delta: "I would rather not." },
        { type: "finish", reason: "stop", usage: usage(3, 3) },
      ]),
      prompt: "go",
      output: COPY,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_output");
    expect(result.messages.at(-1)!.content).toEqual([
      { type: "text", text: "I would rather not." },
    ]);
  });

  describe("a provider failure", () => {
    test("reported as an event is returned with its own code, and usage still counts", async () => {
      // A content filter does exactly this: an error, then a finish that bills.
      const result = await generate({
        provider: fakeProvider([
          {
            type: "error",
            error: { code: "content_filtered", message: "blocked", retryable: false },
          },
          { type: "finish", reason: "stop", usage: usage(9, 2) },
        ]),
        prompt: "go",
        output: COPY,
      });

      expect(result).toMatchObject({
        ok: false,
        finishReason: "error",
        error: { code: "content_filtered", message: "blocked" },
        usage: usage(9, 2),
      });
      expect(result.messages.at(-1)).toMatchObject({ role: "assistant", finishReason: "error" });
    });

    test("thrown by the provider is normalized by the provider, not thrown on", async () => {
      const provider = fakeProvider();
      provider.stream = () => {
        throw new Error("socket hang up");
      };

      const result = await generate({ provider, prompt: "go", output: COPY });

      expect(result).toMatchObject({
        ok: false,
        finishReason: "error",
        error: { code: "provider_error", message: "socket hang up" },
      });
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    test("thrown mid-stream keeps the usage already reported", async () => {
      const provider = fakeProvider();
      provider.stream = () =>
        (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: "finish", reason: "stop", usage: usage(4, 0) };
          throw new Error("stream reset");
        })();

      const result = await generate({ provider, prompt: "go", output: COPY });

      expect(result.error?.message).toBe("stream reset");
      expect(result.usage).toEqual(usage(4, 0));
    });
  });

  describe("abort and timeout", () => {
    test("an abort resolves ok: false with code aborted, even from a provider that ignores it", async () => {
      const provider = hangingProvider();
      const controller = new AbortController();

      const pending = generate({ provider, prompt: "go", output: COPY, signal: controller.signal });
      await provider.started;
      controller.abort();
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        finishReason: "aborted",
        error: { code: "aborted", message: "The generation was stopped.", retryable: false },
      });
      // Handed to the provider too, so a real one cancels its request.
      expect(provider.calls[0].signal).toBe(controller.signal);
    });

    test("an AbortSignal.timeout says it timed out, and is worth retrying", async () => {
      const result = await generate({
        provider: hangingProvider(),
        prompt: "go",
        output: COPY,
        signal: AbortSignal.timeout(20),
      });

      // `timeout`, the code a run's deadline and a tool's `timeoutMs` report.
      expect(result.error).toEqual({
        code: "timeout",
        message: "The generation timed out.",
        retryable: true,
      });
    });

    test("an already-aborted signal makes no progress", async () => {
      const provider = fakeProvider(answer({ headline: "h", cta: "c" }));
      const result = await generate({
        provider,
        prompt: "go",
        output: COPY,
        signal: AbortSignal.abort(),
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("aborted");
    });
  });

  describe("a failure's status and request id", () => {
    test("come from an error event, as on an agent run's result().error", async () => {
      const result = await generate({
        provider: fakeProvider([
          {
            type: "error",
            error: { code: "rate_limited", message: "slow down", retryable: true },
            status: 429,
            requestId: "req_1",
          },
        ]),
        prompt: "go",
        output: COPY,
      });

      expect(result.error).toEqual({
        code: "rate_limited",
        message: "slow down",
        retryable: true,
        status: 429,
        requestId: "req_1",
      });
    });

    test("come from a thrown error", async () => {
      const provider = hangingProvider();
      provider.stream = () => {
        throw Object.assign(new Error("bad request"), { status: 400, requestId: "req_2" });
      };
      const result = await generate({ provider, prompt: "go", output: COPY });

      expect(result.error).toMatchObject({
        code: "provider_error",
        status: 400,
        requestId: "req_2",
      });
    });

    test("are absent when there was no response", async () => {
      const result = await generate({
        provider: fakeProvider(answer({ headline: 1 })),
        prompt: "go",
        output: COPY,
      });

      expect(result.error).not.toHaveProperty("status");
      expect(result.error).not.toHaveProperty("requestId");
    });
  });

  describe("throwOnError", () => {
    test("rejects with an AgentRunError carrying the transcript and the usage", async () => {
      const error = await generate({
        provider: fakeProvider(answer({ headline: 1 }, usage(8, 4))),
        prompt: "go",
        output: COPY,
        throwOnError: true,
      }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(AgentRunError);
      const run = error as AgentRunError;
      expect(run.code).toBe("invalid_output");
      expect(run.retryable).toBe(true);
      expect(run.runId).toMatch(/^gen_/);
      expect(run.result.usage).toEqual(usage(8, 4));
      expect(run.result.finishReason).toBe("stop");
      expect(run.result.messages.at(-1)).toMatchObject({ role: "assistant" });
    });

    test("carries the status and request id", async () => {
      const failing = generate({
        provider: fakeProvider([
          {
            type: "error",
            error: { code: "rate_limited", message: "slow down", retryable: true },
            status: 429,
            requestId: "req_1",
          },
        ]),
        prompt: "go",
        output: COPY,
        throwOnError: true,
      });

      await expect(failing).rejects.toMatchObject({
        name: "AgentRunError",
        code: "rate_limited",
        status: 429,
        requestId: "req_1",
      });
    });

    test("resolves the ok: true result on success", async () => {
      const result = await generate({
        provider: fakeProvider(answer({ headline: "h", cta: "c" })),
        prompt: "go",
        output: COPY,
        throwOnError: true,
      });

      expect(result).toMatchObject({ ok: true, output: { headline: "h", cta: "c" } });
    });

    test("rejects on a stop too, since there is no output to resolve with", async () => {
      await expect(
        generate({
          provider: fakeProvider(answer({ headline: "h", cta: "c" })),
          prompt: "go",
          output: COPY,
          signal: AbortSignal.abort(),
          throwOnError: true,
        }),
      ).rejects.toMatchObject({ code: "aborted" });
    });
  });

  describe("logging", () => {
    test("a failure is logged by default, with its code and status", async () => {
      await generate({
        provider: fakeProvider([
          {
            type: "error",
            error: { code: "rate_limited", message: "slow down", retryable: true },
            status: 429,
          },
        ]),
        prompt: "go",
        output: COPY,
      });

      const logs = generateLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0][0]).toBe("[gemi/ai] generate() failed (rate_limited 429): slow down");
      expect(logs[0][1]).toMatchObject({
        generateId: expect.stringMatching(/^gen_/),
        error: { code: "rate_limited", status: 429 },
      });
    });

    test("an invalid answer and a timeout are failures too", async () => {
      await generate({
        provider: fakeProvider(answer({ headline: 1 })),
        prompt: "go",
        output: COPY,
      });
      await generate({
        provider: hangingProvider(),
        prompt: "go",
        output: COPY,
        signal: AbortSignal.timeout(10),
      });

      expect(generateLogs().map((call) => call[0])).toEqual([
        expect.stringContaining("(invalid_output)"),
        expect.stringContaining("(timeout)"),
      ]);
    });

    test("logErrors: false keeps it quiet", async () => {
      await generate({
        provider: fakeProvider(answer({ headline: 1 })),
        prompt: "go",
        output: COPY,
        logErrors: false,
      });

      expect(generateLogs()).toEqual([]);
    });

    test("neither a stop nor a success is logged", async () => {
      await generate({
        provider: fakeProvider(answer({ headline: "h", cta: "c" })),
        prompt: "go",
        output: COPY,
        signal: AbortSignal.abort(),
      });
      await generate({
        provider: fakeProvider(answer({ headline: "h", cta: "c" })),
        prompt: "go",
        output: COPY,
      });

      expect(generateLogs()).toEqual([]);
    });
  });
});

// --- ctx.generate ------------------------------------------------------------

/** A parent agent whose one tool runs `body` and returns what it returns. */
function parentWith(body: (ctx: any) => Promise<unknown>) {
  const tool = AgentTool.create({
    name: "write",
    description: "x",
    inputSchema: s.object({}),
    execute: (_input: any, ctx: any) => body(ctx),
  });
  return Agent.create({
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
}

async function drain(run: AsyncIterable<AgentStreamEvent>) {
  const events: AgentStreamEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe("ctx.generate", () => {
  test("rolls its usage into the turn's, and sends the client nothing", async () => {
    const inner = fakeProvider(answer({ headline: "h", cta: "c" }, usage(7, 3)));
    let seen: unknown;
    const agent = parentWith(async (ctx) => {
      const result = await ctx.generate({ provider: inner, prompt: "go", output: COPY });
      seen = result;
      return result.ok ? result.output : null;
    });

    const run = agent.stream({ messages: [] });
    const events = await drain(run);
    const result = await run.result();

    expect(seen).toMatchObject({ ok: true, output: { headline: "h", cta: "c" } });
    // 100 + 200 from the two parent steps, 7 + 3 from the call inside the tool.
    expect(result.usage).toEqual(usage(307, 33));
    expect(events.find((event) => event.type === "usage")).toEqual({
      type: "usage",
      usage: usage(307, 33),
    });
    // Server only: no nested transcript, no output deltas, no stray message.
    const types = new Set(events.map((event) => event.type));
    expect(types.has("nested-event")).toBe(false);
    expect(types.has("output-delta")).toBe(false);
    expect(types.has("message")).toBe(false);
    // And nothing recorded on the tool call.
    const call = result.messages
      .flatMap((m) => m.content)
      .find((part) => part.type === "tool-call") as any;
    expect(call.nested).toBeUndefined();
  });

  test("counts the usage of a failed answer too", async () => {
    const inner = fakeProvider(answer({ headline: 1 }, usage(7, 3)));
    let code: string | undefined;
    const agent = parentWith(async (ctx) => {
      const result = await ctx.generate({ provider: inner, prompt: "go", output: COPY });
      code = result.error?.code;
      return "done";
    });

    const result = await agent.stream({ messages: [] }).result();

    expect(code).toBe("invalid_output");
    expect(result.usage).toEqual(usage(307, 33));
  });

  test("aborts with the turn, without the tool passing a signal", async () => {
    const inner = hangingProvider();
    let settled = false;
    let carriedOn = false;
    const agent = parentWith(async (ctx) => {
      try {
        const result = await ctx.generate({ provider: inner, prompt: "go", output: COPY });
        // A save, say. It must not happen for a turn the user stopped.
        carriedOn = true;
        return result;
      } finally {
        settled = true;
      }
    });

    const run = agent.stream({ messages: [] });
    const draining = drain(run);
    await inner.started;
    run.stop();
    const result = await run.result();
    await draining;

    expect(result.finishReason).toBe("aborted");
    // The provider was handed a signal that the stop reached.
    expect(inner.calls[0].signal?.aborted).toBe(true);
    // And the tool body was released rather than left waiting on the model.
    await Promise.resolve();
    expect(settled).toBe(true);
    // Thrown out of the body, as `runAgent` does, rather than returned as an
    // `aborted` result the body would carry on past.
    expect(carriedOn).toBe(false);
  });

  test("combines a signal of the tool's own with the turn's", async () => {
    const inner = hangingProvider();
    let seen: any;
    const agent = parentWith(async (ctx) => {
      seen = await ctx.generate({
        provider: inner,
        prompt: "go",
        output: COPY,
        signal: AbortSignal.timeout(20),
      });
      return "gave up";
    });

    const result = await agent.stream({ messages: [] }).result();

    // The tool's timeout fired and the turn carried on: a result, not a throw.
    expect(seen).toMatchObject({ ok: false, error: { code: "timeout", retryable: true } });
    expect(result.finishReason).toBe("stop");
    // It is not the turn's signal that was handed down, but one tied to it.
    expect(inner.calls[0].signal).toBeDefined();
  });

  test("a tool's own timeoutMs reaches it as a timeout", async () => {
    const inner = hangingProvider();
    const settled = deferred<unknown>();
    const tool = AgentTool.create({
      name: "write",
      description: "x",
      inputSchema: s.object({}),
      timeoutMs: 20,
      execute: async (_input: any, ctx: any) => {
        settled.resolve(await ctx.generate({ provider: inner, prompt: "go", output: COPY }));
        return "late";
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

    expect(result.finishReason).toBe("stop");
    expect(await settled.promise).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  test("logs a failure with the agent, run and tool call it came from", async () => {
    const agent = parentWith(async (ctx) => {
      await ctx.generate({
        provider: fakeProvider(answer({ headline: 1 })),
        prompt: "go",
        output: COPY,
      });
      return "done";
    });

    const result = await agent.stream({ messages: [] }).result();

    const logs = generateLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({
      agent: "lead",
      runId: result.runId,
      toolCallId: "c1",
      error: { code: "invalid_output" },
    });
  });

  test("with throwOnError, rejects in the tool and still counts the usage", async () => {
    const inner = fakeProvider(answer({ headline: 1 }, usage(7, 3)));
    let caught: unknown;
    const agent = parentWith(async (ctx) => {
      try {
        await ctx.generate({ provider: inner, prompt: "go", output: COPY, throwOnError: true });
      } catch (error) {
        caught = error;
      }
      return "done";
    });

    const result = await agent.stream({ messages: [] }).result();

    expect(caught).toBeInstanceOf(AgentRunError);
    expect((caught as AgentRunError).code).toBe("invalid_output");
    expect(result.usage).toEqual(usage(307, 33));
  });
});

describe("an agent's own output schema mismatch", () => {
  test("reports invalid_output, the same code generate uses", async () => {
    const agent = Agent.create({
      name: "a",
      provider: fakeProvider(answer({ headline: 42 })),
      output: COPY,
    });

    const events = await drain(agent.stream({ messages: [] }));

    expect(events.find((event) => event.type === "error")).toMatchObject({
      error: { code: "invalid_output", retryable: true },
    });
  });
});

/**
 * `ok` narrows `output` and `error` — in a strict program, which is how an app
 * compiles and how this package does not. See the fixture's header.
 */
describe("the result's types, under strict", () => {
  test("narrow on ok, and destructure without it", { timeout: 60_000 }, () => {
    const PACKAGE = path.join(import.meta.dirname, "..");
    const result = Bun.spawnSync(
      [
        path.join(PACKAGE, "node_modules", ".bin", "tsc"),
        "--noEmit",
        "-p",
        "ai/__fixtures__/generate/tsconfig.json",
      ],
      { cwd: PACKAGE },
    );
    // Only the fixture's own errors. It reaches the framework's source through
    // `gemi/ai`, and that source is not written for `strict` — an app never
    // compiles it that way either, since it ships as declarations. An import
    // that failed to resolve, or an `@ts-expect-error` that stopped being one,
    // is reported against the fixture and still fails this.
    const errors = `${result.stdout.toString()}${result.stderr.toString()}`
      .split("\n")
      .filter((line) => line.includes("error TS") && line.includes("__fixtures__/generate/"));

    expect(errors).toEqual([]);
  });
});
