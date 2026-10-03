process.env.SECRET ??= "fallback-test-secret";

import { describe, expect, test } from "vitest";

import { Agent } from "./Agent";
import { MemoryCircuitStore } from "./CircuitStore";
import type { AgentProvider, ProviderEvent, ProviderStreamParams } from "./AgentProvider";
import { evalChain, FallbackProvider, type FallbackUsage } from "./FallbackProvider";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentError, Usage } from "./types";

const usage = (input: number, output: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
});

const finish = (u: Usage = usage(1, 1)): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: u,
});

const retryable: AgentError = { code: "rate_limited", message: "slow down", retryable: true };
const final: AgentError = {
  code: "context_length_exceeded",
  message: "too long",
  retryable: false,
};

/** A provider whose model and capabilities can be set, around `fakeProvider`. */
function leg(model: string, ...scripts: ProviderEvent[][]) {
  const provider = fakeProvider(...scripts);
  Object.defineProperty(provider, "model", { value: model });
  return provider;
}

/** A provider that never answers until its signal aborts — the hung primary. */
function hanging(model = "hung") {
  const seen: { aborted: boolean }[] = [];
  const provider = {
    model,
    capabilities: leg("x").capabilities,
    seen,
    stream(params: ProviderStreamParams) {
      const record = { aborted: false };
      seen.push(record);
      return (async function* (): AsyncGenerator<ProviderEvent> {
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener("abort", () => {
            record.aborted = true;
            resolve();
          });
        });
        yield { type: "finish", reason: "aborted", usage: usage(0, 0) };
      })();
    },
    upload: async () => "file_hung",
    normalizeError: (error: unknown) => ({
      code: "provider_error" as const,
      message: String(error),
      retryable: false,
    }),
  };
  return provider as unknown as AgentProvider & { seen: { aborted: boolean }[] };
}

async function collect(stream: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const text = (events: ProviderEvent[]) =>
  events.map((e) => (e.type === "text-delta" ? e.delta : "")).join("");

describe("FallbackProvider", () => {
  test("the primary answering means no fallback is asked", async () => {
    const primary = leg("a", [{ type: "text-delta", delta: "hi" }, finish()]);
    const secondary = leg("b", [{ type: "text-delta", delta: "no" }, finish()]);
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }]);

    const events = await collect(chain.stream({ messages: [] }));
    expect(text(events)).toBe("hi");
    expect(secondary.calls).toHaveLength(0);
  });

  test("a retryable failure before output falls back, and the failed leg leaves no trace", async () => {
    const primary = leg("a", [
      { type: "error", error: retryable, status: 429, requestId: "req_1" },
      { type: "finish", reason: "error", usage: usage(0, 0) },
    ]);
    const secondary = leg("b", [{ type: "text-delta", delta: "from b" }, finish(usage(10, 5))]);
    const reports: FallbackUsage[] = [];
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }], {
      onUsage: (report) => reports.push(report),
    });

    const events = await collect(chain.stream({ messages: [] }));
    expect(events).toEqual([
      { type: "text-delta", delta: "from b" },
      { type: "finish", reason: "stop", usage: usage(10, 5) },
    ]);
    expect(reports).toEqual([
      {
        index: 0,
        model: "a",
        attempt: 1,
        usage: usage(0, 0),
        outcome: "fallback",
        error: retryable,
      },
      { index: 1, model: "b", attempt: 2, usage: usage(10, 5), outcome: "ok" },
    ]);
  });

  describe("which model answered (#741)", () => {
    const answered = (u: Usage, model: string): ProviderEvent => ({
      type: "finish",
      reason: "stop",
      usage: u,
      model,
    });

    test("each leg's report carries the model its vendor says answered", async () => {
      const primary = leg("sol", [
        { type: "error", error: retryable, status: 429 },
        { type: "finish", reason: "error", usage: usage(3, 0), model: "gpt-5.6-sol-2026-09-01" },
      ]);
      const secondary = leg("gpt-5.4", [
        { type: "text-delta", delta: "b" },
        answered(usage(10, 5), "gpt-5.4-2026-03-05"),
      ]);
      const reports: FallbackUsage[] = [];
      const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }], {
        onUsage: (r) => reports.push(r),
      });

      const events = await collect(chain.stream({ messages: [] }));
      expect(reports.map((r) => [r.model, r.responseModel, r.outcome])).toEqual([
        ["sol", "gpt-5.6-sol-2026-09-01", "fallback"],
        ["gpt-5.4", "gpt-5.4-2026-03-05", "ok"],
      ]);
      // The closing finish is the answering leg's, with the failed leg's cost on it.
      expect(events.at(-1)).toEqual({
        type: "finish",
        reason: "stop",
        usage: usage(13, 5),
        model: "gpt-5.4-2026-03-05",
      });
    });

    test("a leg whose provider does not say has no responseModel key", async () => {
      const reports: FallbackUsage[] = [];
      const chain = FallbackProvider.chain(
        [{ provider: leg("a", [{ type: "text-delta", delta: "a" }, finish()]) }],
        { onUsage: (r) => reports.push(r) },
      );
      const events = await collect(chain.stream({ messages: [] }));
      expect(Object.keys(reports[0]!)).not.toContain("responseModel");
      expect(Object.keys(events.at(-1)!)).not.toContain("model");
    });

    test("a final failure keeps the model on the closing finish it writes", async () => {
      const chain = FallbackProvider.chain([
        {
          provider: leg("a", [
            { type: "error", error: final },
            { type: "finish", reason: "error", usage: usage(1, 0), model: "gpt-4o" },
          ]),
        },
      ]);
      const events = await collect(chain.stream({ messages: [] }));
      expect(events.at(-1)).toEqual({
        type: "finish",
        reason: "error",
        usage: usage(1, 0),
        model: "gpt-4o",
      });
    });
  });

  test("a failed leg that billed tokens is added to the closing usage", async () => {
    const primary = leg("a", [
      { type: "error", error: retryable },
      { type: "finish", reason: "error", usage: usage(100, 0) },
    ]);
    const secondary = leg("b", [{ type: "text-delta", delta: "ok" }, finish(usage(10, 5))]);
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }]);

    const events = await collect(chain.stream({ messages: [] }));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop", usage: usage(110, 5) });
  });

  test("a non-retryable failure is final by default", async () => {
    const primary = leg("a", [
      { type: "error", error: final, status: 400 },
      { type: "finish", reason: "error", usage: usage(0, 0) },
    ]);
    const secondary = leg("b", [{ type: "text-delta", delta: "nope" }, finish()]);
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }]);

    const events = await collect(chain.stream({ messages: [] }));
    expect(events).toEqual([
      { type: "error", error: final, status: 400 },
      { type: "finish", reason: "error", usage: usage(0, 0) },
    ]);
    expect(secondary.calls).toHaveLength(0);
  });

  test("fallbackOn decides, and sees the status", async () => {
    const primary = leg("a", [
      { type: "error", error: final, status: 400 },
      { type: "finish", reason: "error", usage: usage(0, 0) },
    ]);
    const secondary = leg("b", [{ type: "text-delta", delta: "b" }, finish()]);
    const seen: unknown[] = [];
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }], {
      fallbackOn: (error, failure) => {
        seen.push({ code: error.code, ...failure });
        return failure.status === 400;
      },
    });

    expect(text(await collect(chain.stream({ messages: [] })))).toBe("b");
    expect(seen).toEqual([
      { code: "context_length_exceeded", index: 0, model: "a", status: 400, timedOut: false },
    ]);
  });

  test("the last leg's failure is reported as it is", async () => {
    const a = leg("a", [{ type: "error", error: retryable }, finish(usage(0, 0))]);
    const b = leg("b", [{ type: "error", error: retryable }, finish(usage(0, 0))]);
    const chain = FallbackProvider.chain([{ provider: a }, { provider: b }]);

    const events = await collect(chain.stream({ messages: [] }));
    expect(events[0]).toEqual({ type: "error", error: retryable });
    expect(events.at(-1)?.type).toBe("finish");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  test("a provider that throws is normalized and falls back like an error event", async () => {
    const thrower = {
      model: "thrower",
      capabilities: leg("x").capabilities,
      stream() {
        return (async function* (): AsyncGenerator<ProviderEvent> {
          // Fails on the first `next()`, before any event: a refused connection.
          yield* [];
          throw new Error("socket closed");
        })();
      },
      upload: async () => "f",
      normalizeError: (error: unknown) => ({
        code: "provider_error" as const,
        message: (error as Error).message,
        retryable: true,
      }),
    } as unknown as AgentProvider;
    const secondary = leg("b", [{ type: "text-delta", delta: "b" }, finish()]);
    const chain = FallbackProvider.chain([{ provider: thrower }, { provider: secondary }]);
    expect(text(await collect(chain.stream({ messages: [] })))).toBe("b");
  });

  describe("no fallback once output has streamed", () => {
    test("an error after a text delta is final, and the text stays", async () => {
      const primary = leg("a", [
        { type: "text-delta", delta: "half an ans" },
        { type: "error", error: retryable },
        { type: "finish", reason: "error", usage: usage(5, 3) },
      ]);
      const secondary = leg("b", [{ type: "text-delta", delta: "second answer" }, finish()]);
      const reports: FallbackUsage[] = [];
      const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }], {
        onUsage: (r) => reports.push(r),
      });

      const events = await collect(chain.stream({ messages: [] }));
      expect(events).toEqual([
        { type: "text-delta", delta: "half an ans" },
        { type: "error", error: retryable },
        { type: "finish", reason: "error", usage: usage(5, 3) },
      ]);
      expect(secondary.calls).toHaveLength(0);
      expect(reports).toEqual([
        {
          index: 0,
          model: "a",
          attempt: 1,
          usage: usage(5, 3),
          outcome: "failed",
          error: retryable,
        },
      ]);
    });

    test.each<[string, ProviderEvent]>([
      ["tool-call", { type: "tool-call", toolCallId: "c1", name: "grep", args: "{}" }],
      ["output-delta", { type: "output-delta", delta: '{"a":' }],
      ["reasoning-delta", { type: "reasoning-delta", delta: "thinking", id: "rs_1" }],
    ])("a %s commits the leg too", async (_, first) => {
      const primary = leg("a", [first, { type: "error", error: retryable }, finish(usage(0, 0))]);
      const secondary = leg("b", [{ type: "text-delta", delta: "b" }, finish()]);
      const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }]);

      const events = await collect(chain.stream({ messages: [] }));
      expect(events[0]).toEqual(first);
      expect(events[1]).toEqual({ type: "error", error: retryable });
      expect(secondary.calls).toHaveLength(0);
    });

    test("a provider that throws after output ends the call with an error, not a fallback", async () => {
      const primary = {
        model: "a",
        capabilities: leg("x").capabilities,
        stream() {
          return (async function* (): AsyncGenerator<ProviderEvent> {
            yield { type: "text-delta", delta: "partial" };
            throw new Error("socket closed");
          })();
        },
        upload: async () => "f",
        normalizeError: (error: unknown) => ({
          code: "provider_error" as const,
          message: (error as Error).message,
          retryable: true,
        }),
      } as unknown as AgentProvider;
      const secondary = leg("b", [{ type: "text-delta", delta: "b" }, finish()]);
      const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }]);

      const events = await collect(chain.stream({ messages: [] }));
      expect(events.map((e) => e.type)).toEqual(["text-delta", "error", "finish"]);
      expect(text(events)).toBe("partial");
      expect(secondary.calls).toHaveLength(0);
    });

    test("through an Agent, the message holds only the first leg's text", async () => {
      const primary = leg("a", [
        { type: "text-delta", delta: "Hel" },
        { type: "error", error: retryable },
        { type: "finish", reason: "error", usage: usage(0, 0) },
      ]);
      const secondary = leg("b", [{ type: "text-delta", delta: "Other" }, finish()]);
      const agent = Agent.create({
        name: "chain",
        provider: FallbackProvider.chain([{ provider: primary }, { provider: secondary }]),
      });
      const result = await agent.stream({ messages: [] }).result();
      const said = result.messages
        .flatMap((m) => m.content)
        .map((p: any) => (p.type === "text" ? p.text : ""))
        .join("");
      expect(said).toBe("Hel");
      expect(result.finishReason).toBe("error");
      expect(secondary.calls).toHaveLength(0);
    });
  });

  describe("per-leg timeout", () => {
    test("a leg that sends nothing in time is aborted and the next one answers", async () => {
      const primary = hanging("a");
      const secondary = leg("b", [{ type: "text-delta", delta: "b" }, finish()]);
      const reports: FallbackUsage[] = [];
      const chain = FallbackProvider.chain(
        [
          { provider: primary, timeoutMs: 20 },
          { provider: secondary, timeoutMs: 1000 },
        ],
        { onUsage: (r) => reports.push(r) },
      );

      expect(text(await collect(chain.stream({ messages: [] })))).toBe("b");
      expect(primary.seen[0]?.aborted).toBe(true);
      expect(reports[0]).toMatchObject({ index: 0, outcome: "fallback" });
      expect(reports[0]?.error?.retryable).toBe(true);
    });

    test("the deadline is for the first event only", async () => {
      const slow = {
        model: "slow",
        capabilities: leg("x").capabilities,
        stream() {
          return (async function* (): AsyncGenerator<ProviderEvent> {
            yield { type: "text-delta", delta: "a" };
            await new Promise((r) => setTimeout(r, 60));
            yield { type: "text-delta", delta: "b" };
            yield finish();
          })();
        },
        upload: async () => "f",
        normalizeError: () => ({ code: "unknown" as const, message: "", retryable: false }),
      } as unknown as AgentProvider;
      const secondary = leg("never", [{ type: "text-delta", delta: "x" }, finish()]);
      const chain = FallbackProvider.chain([
        { provider: slow, timeoutMs: 20 },
        { provider: secondary },
      ]);

      expect(text(await collect(chain.stream({ messages: [] })))).toBe("ab");
      expect(secondary.calls).toHaveLength(0);
    });

    test("fallbackOn is told the leg timed out", async () => {
      const failures: unknown[] = [];
      const chain = FallbackProvider.chain(
        [
          { provider: hanging("a"), timeoutMs: 10 },
          { provider: leg("b", [{ type: "text-delta", delta: "b" }, finish()]) },
        ],
        {
          fallbackOn: (_, failure) => {
            failures.push(failure);
            return true;
          },
        },
      );
      await collect(chain.stream({ messages: [] }));
      expect(failures).toEqual([{ index: 0, model: "a", timedOut: true }]);
    });
  });

  test("a user abort is not a reason to try the next model", async () => {
    const primary = hanging("a");
    const secondary = leg("b", [{ type: "text-delta", delta: "b" }, finish()]);
    const controller = new AbortController();
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }]);

    const pending = collect(chain.stream({ messages: [], signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    const events = await pending;

    expect(events).toEqual([{ type: "finish", reason: "aborted", usage: usage(0, 0) }]);
    expect(secondary.calls).toHaveLength(0);
  });

  test("per-entry reasoning overrides the call's", async () => {
    const a = leg("a", [{ type: "error", error: retryable }, finish(usage(0, 0))]);
    const b = leg("b", [{ type: "error", error: retryable }, finish(usage(0, 0))]);
    const c = leg("c", [{ type: "text-delta", delta: "c" }, finish()]);
    const chain = FallbackProvider.chain([
      { provider: a, reasoning: "low" },
      { provider: b },
      { provider: c, reasoning: "high" },
    ]);
    await collect(chain.stream({ messages: [], reasoning: "medium" }));
    expect(a.calls[0]?.reasoning).toBe("low");
    expect(b.calls[0]?.reasoning).toBe("medium");
    expect(c.calls[0]?.reasoning).toBe("high");
  });

  test("capabilities are the intersection of the legs'", () => {
    const a = leg("a");
    const b = leg("b");
    Object.defineProperty(b, "capabilities", {
      value: { ...a.capabilities, toolSearch: false, fileInput: false },
    });
    const chain = FallbackProvider.chain([{ provider: a }, { provider: b }]);
    expect(chain.capabilities).toEqual({
      reasoning: true,
      structuredOutput: true,
      fileInput: false,
      parallelToolCalls: true,
      toolSearch: false,
    });
    expect(chain.model).toBe("a");
  });

  test("from() enters the chain later and never reaches the primary", async () => {
    const a = leg("a", [{ type: "text-delta", delta: "a" }, finish()]);
    const b = leg("b", [{ type: "text-delta", delta: "b" }, finish()]);
    const reports: FallbackUsage[] = [];
    const chain = FallbackProvider.chain([{ provider: a }, { provider: b }], {
      onUsage: (r) => reports.push(r),
    });
    const textTasks = chain.from(1);

    expect(textTasks.model).toBe("b");
    expect(text(await collect(textTasks.stream({ messages: [] })))).toBe("b");
    expect(a.calls).toHaveLength(0);
    expect(reports[0]).toMatchObject({ index: 0, model: "b", attempt: 1 });
    expect(() => chain.from(2)).toThrow(RangeError);
  });

  test("upload goes to the first leg only", async () => {
    const a = leg("a");
    const b = leg("b");
    const chain = FallbackProvider.chain([{ provider: a }, { provider: b }]);
    expect(await chain.upload(new File(["x"], "x.txt"))).toBe("file_1");
    expect(a.uploads).toHaveLength(1);
    expect(b.uploads).toHaveLength(0);
  });

  test("an onUsage that throws does not break the call", async () => {
    const chain = FallbackProvider.chain(
      [{ provider: leg("a", [{ type: "text-delta", delta: "a" }, finish()]) }],
      {
        onUsage: () => {
          throw new Error("logger down");
        },
      },
    );
    expect(text(await collect(chain.stream({ messages: [] })))).toBe("a");
  });

  test("refuses an empty chain and a non-positive timeout", () => {
    expect(() => FallbackProvider.chain([])).toThrow();
    expect(() => FallbackProvider.chain([{ provider: leg("a"), timeoutMs: 0 }])).toThrow();
  });
});

describe("evalChain", () => {
  test("runs the fixture against each leg on its own, samples times", async () => {
    const failing: ProviderEvent[] = [{ type: "error", error: retryable }, finish(usage(0, 0))];
    const a = leg("a", failing, failing);
    const b = leg("b", [{ type: "text-delta", delta: "b1" }, finish()], [
      { type: "text-delta", delta: "b2" },
      finish(),
    ]);
    const chain = FallbackProvider.chain([{ provider: a, reasoning: "low" }, { provider: b }]);

    const results = await evalChain(
      chain,
      async (provider) => {
        const events = await collect(provider.stream({ messages: [] }));
        const error = events.find((e) => e.type === "error");
        if (error) throw new Error("failed");
        return text(events);
      },
      { samples: 2 },
    );

    expect(results.map((r) => [r.model, r.results, r.errors.map((e) => e.sample)])).toEqual([
      ["a", [], [0, 1]],
      ["b", ["b1", "b2"], []],
    ]);
    // No fallback between legs: `a` failing never sent anything to `b`.
    expect(b.calls).toHaveLength(2);
    expect(a.calls[0]?.reasoning).toBe("low");
  });
});

describe("circuit breaking (#742)", () => {
  const failing = (): ProviderEvent[] => [
    { type: "error", error: retryable, status: 503 },
    { type: "finish", reason: "error", usage: usage(0, 0) },
  ];
  const answer = (said: string): ProviderEvent[] => [{ type: "text-delta", delta: said }, finish()];
  const times = <T>(n: number, make: () => T) => Array.from({ length: n }, make);

  /** A clock the test moves, for a store whose cool-down it can end. */
  function clock() {
    let now = 1_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  test("a leg that keeps failing is skipped, and the next leg answers at once", async () => {
    const primary = leg("a", ...times(5, failing));
    const secondary = leg("b", ...times(5, () => answer("b")));
    const changes: unknown[] = [];
    const reports: FallbackUsage[] = [];
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: secondary }], {
      circuit: { failures: 2, onStateChange: (change) => changes.push(change) },
      onUsage: (r) => reports.push(r),
    });

    await collect(chain.stream({ messages: [] }));
    await collect(chain.stream({ messages: [] }));
    expect(changes).toEqual([{ index: 0, model: "a", key: "a", state: "open" }]);

    reports.length = 0;
    expect(text(await collect(chain.stream({ messages: [] })))).toBe("b");
    expect(primary.calls).toHaveLength(2);
    // The skipped leg is not tried, so not reported, and the leg that was is attempt 1.
    expect(reports).toEqual([
      { index: 1, model: "b", attempt: 1, usage: usage(1, 1), outcome: "ok" },
    ]);
  });

  test("without `circuit` every call still tries the primary", async () => {
    const primary = leg("a", ...times(4, failing));
    const chain = FallbackProvider.chain([
      { provider: primary },
      { provider: leg("b", ...times(4, () => answer("b"))) },
    ]);
    for (let i = 0; i < 4; i++) await collect(chain.stream({ messages: [] }));
    expect(primary.calls).toHaveLength(4);
  });

  test("failures must be in a row: a success in between starts the count again", async () => {
    const primary = leg("a", failing(), answer("a"), failing(), failing());
    const chain = FallbackProvider.chain(
      [{ provider: primary }, { provider: leg("b", ...times(4, () => answer("b"))) }],
      { circuit: { failures: 2 } },
    );
    for (let i = 0; i < 4; i++) await collect(chain.stream({ messages: [] }));
    expect(primary.calls).toHaveLength(4);
  });

  test("after the cool-down one call probes; an answer closes the circuit", async () => {
    const time = clock();
    const primary = leg("a", failing(), answer("a again"), answer("a"));
    const changes: string[] = [];
    const chain = FallbackProvider.chain(
      [{ provider: primary }, { provider: leg("b", ...times(3, () => answer("b"))) }],
      {
        circuit: {
          failures: 1,
          cooldownMs: 1_000,
          store: new MemoryCircuitStore(time.now),
          onStateChange: ({ state }) => changes.push(state),
        },
      },
    );

    await collect(chain.stream({ messages: [] }));
    expect(text(await collect(chain.stream({ messages: [] })))).toBe("b");
    time.advance(1_000);
    expect(text(await collect(chain.stream({ messages: [] })))).toBe("a again");
    expect(text(await collect(chain.stream({ messages: [] })))).toBe("a");
    expect(changes).toEqual(["open", "closed"]);
  });

  test("a probe that fails opens the circuit again at once", async () => {
    const time = clock();
    const store = new MemoryCircuitStore(time.now);
    const primary = leg("a", ...times(4, failing));
    const chain = FallbackProvider.chain(
      [{ provider: primary }, { provider: leg("b", ...times(4, () => answer("b"))) }],
      { circuit: { failures: 3, cooldownMs: 1_000, store } },
    );

    for (let i = 0; i < 3; i++) await collect(chain.stream({ messages: [] }));
    expect(store.state("a")).toBe("open");
    time.advance(1_000);
    expect(store.state("a")).toBe("half-open");
    await collect(chain.stream({ messages: [] }));
    expect(primary.calls).toHaveLength(4);
    expect(store.state("a")).toBe("open");
    await collect(chain.stream({ messages: [] }));
    expect(primary.calls).toHaveLength(4);
  });

  test("a timeout counts as a failure", async () => {
    const primary = hanging("a");
    const chain = FallbackProvider.chain(
      [
        { provider: primary, timeoutMs: 10 },
        { provider: leg("b", ...times(2, () => answer("b"))) },
      ],
      { circuit: { failures: 1 } },
    );
    await collect(chain.stream({ messages: [] }));
    await collect(chain.stream({ messages: [] }));
    expect(primary.seen).toHaveLength(1);
  });

  test("a failure the chain does not fall back on does not count", async () => {
    const primary = leg("a", ...times(3, () => [
      { type: "error", error: final, status: 400 } as ProviderEvent,
      { type: "finish", reason: "error", usage: usage(0, 0) } as ProviderEvent,
    ]));
    const chain = FallbackProvider.chain(
      [{ provider: primary }, { provider: leg("b") }],
      { circuit: { failures: 1 } },
    );
    for (let i = 0; i < 3; i++) await collect(chain.stream({ messages: [] }));
    expect(primary.calls).toHaveLength(3);
  });

  test("a leg that fails after it started answering is up, not down", async () => {
    const primary = leg(
      "a",
      ...times(3, () => [
        { type: "text-delta", delta: "half" } as ProviderEvent,
        { type: "error", error: retryable } as ProviderEvent,
        { type: "finish", reason: "error", usage: usage(0, 0) } as ProviderEvent,
      ]),
    );
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: leg("b") }], {
      circuit: { failures: 1 },
    });
    for (let i = 0; i < 3; i++) await collect(chain.stream({ messages: [] }));
    expect(primary.calls).toHaveLength(3);
  });

  test("the last leg is never skipped, and its failures are not counted", async () => {
    const only = leg("a", ...times(3, failing));
    const chain = FallbackProvider.chain([{ provider: only }], { circuit: { failures: 1 } });
    for (let i = 0; i < 3; i++) await collect(chain.stream({ messages: [] }));
    expect(only.calls).toHaveLength(3);
  });

  test("from() shares the chain's circuits", async () => {
    const a = leg("a", ...times(2, failing));
    const b = leg("b", ...times(3, failing));
    const c = leg("c", ...times(3, () => answer("c")));
    const chain = FallbackProvider.chain([{ provider: a }, { provider: b }, { provider: c }], {
      circuit: { failures: 1 },
    });

    await collect(chain.from(1).stream({ messages: [] }));
    expect(b.calls).toHaveLength(1);
    await collect(chain.stream({ messages: [] }));
    // `b` opened through `from(1)`, so the full chain skips it.
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(2);
  });

  test("a store that throws does not stop the leg being tried", async () => {
    const primary = leg("a", answer("a"));
    const chain = FallbackProvider.chain([{ provider: primary }, { provider: leg("b") }], {
      circuit: {
        store: {
          allow: () => Promise.reject(new Error("redis down")),
          record: () => {
            throw new Error("redis down");
          },
        },
      },
    });
    expect(text(await collect(chain.stream({ messages: [] })))).toBe("a");
  });

  test("two legs on one circuit key are refused, and circuitKey separates them", () => {
    const twins = () => [{ provider: leg("gpt-5.4") }, { provider: leg("gpt-5.4") }];
    expect(() => FallbackProvider.chain(twins(), { circuit: {} })).toThrow(/circuitKey/);
    expect(() => FallbackProvider.chain(twins())).not.toThrow();
    const [one, two] = twins();
    expect(() =>
      FallbackProvider.chain([{ ...one!, circuitKey: "east" }, { ...two!, circuitKey: "west" }], {
        circuit: {},
      }),
    ).not.toThrow();
    const alone = [{ provider: leg("a") }];
    expect(() => FallbackProvider.chain(alone, { circuit: { failures: 0 } })).toThrow();
    expect(() => FallbackProvider.chain(alone, { circuit: { cooldownMs: 0 } })).toThrow();
  });
});
