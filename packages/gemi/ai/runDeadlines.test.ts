process.env.SECRET ??= "run-deadlines-test-secret";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../facades/Log", () => ({ Log: { error: logged.error } }));

import { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentRunError, AgentTool, DEFAULT_MAX_RUN_DURATION_MS } from "./Agent";
import type { AgentProvider, ProviderEvent, ProviderStreamParams } from "./AgentProvider";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage, AgentStreamEvent, ToolResultPart } from "./types";

/**
 * #455: a run has a deadline, a tool can have a timeout, and neither a hung
 * tool nor a hung provider can keep a run open forever.
 *
 * Fake timers throughout: every limit here is minutes long in production, and
 * the property under test is what happens when it runs out, not how long that
 * takes.
 */

beforeEach(() => {
  logged.error.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

const toolCall = (toolCallId: string, name: string, args: unknown = {}): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: JSON.stringify(args),
});

/** Never settles, and does not look at `ctx.signal`: the `fetch` with no
 *  timeout the issue is about. Records the signal it was handed. */
function hungTool(params: { timeoutMs?: number } = {}) {
  const signals: AbortSignal[] = [];
  const tool = AgentTool.create({
    name: "lookup",
    description: "Looks something up, eventually",
    inputSchema: s.object({}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    execute: (_input, ctx) => {
      signals.push(ctx.signal);
      return new Promise<never>(() => {});
    },
  });
  return { tool, signals };
}

/** A provider whose stream yields `before`, then waits forever for the next
 *  event. Records the signal each call was given. */
function stallingProvider(before: ProviderEvent[] = []) {
  const signals: AbortSignal[] = [];
  const provider = {
    model: "stalling",
    capabilities: {
      reasoning: false,
      structuredOutput: true,
      fileInput: false,
      parallelToolCalls: true,
      toolSearch: false,
    },
    stream(params: ProviderStreamParams) {
      if (params.signal) signals.push(params.signal);
      return (async function* () {
        for (const event of before) yield event;
        await new Promise<never>(() => {});
      })();
    },
    upload: async () => "file_1",
    normalizeError: (error: unknown) => ({
      code: "provider_error" as const,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    }),
  };
  return { provider: provider as unknown as AgentProvider, signals };
}

function collect(run: AsyncIterable<AgentStreamEvent>) {
  const events: AgentStreamEvent[] = [];
  const done = (async () => {
    for await (const event of run) events.push(event);
  })();
  return { events, done };
}

const results = (messages: AgentMessage[]) =>
  messages.flatMap((m) => m.content.filter((p) => p.type === "tool-result")) as ToolResultPart[];

describe("maxRunDurationMs", () => {
  test("a hung tool no longer holds the run: it ends as a timeout error with a valid transcript", async () => {
    const { tool, signals } = hungTool();
    const provider = fakeProvider([toolCall("c1", "lookup"), finish()]);
    const reported: AgentMessage[] = [];
    const agent = Agent.create({
      name: "slowpoke",
      provider,
      tools: [tool],
      maxRunDurationMs: 60_000,
    });
    const run = agent.stream({ messages: [], onMessage: (m) => void reported.push(m) });
    const { events, done } = collect(run);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(signals[0]!.aborted).toBe(false);
    expect(events.some((e) => e.type === "run-end")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await run.result();
    await done;

    expect(result.finishReason).toBe("error");
    expect(result.error).toMatchObject({ code: "timeout", retryable: true });
    expect(result.error!.message).toContain("1m");
    // The tool was told: its signal aborted, with a TimeoutError as the reason.
    expect(signals[0]!.aborted).toBe(true);
    expect((signals[0]!.reason as DOMException).name).toBe("TimeoutError");

    // The call is closed, so the next turn's history is one the provider takes.
    const [message] = result.messages;
    expect(message!.finishReason).toBe("error");
    expect(results(result.messages)).toEqual([
      {
        type: "tool-result",
        toolCallId: "c1",
        name: "lookup",
        status: "denied",
        cause: "stopped",
        reason: expect.stringContaining("time limit"),
      },
    ]);
    // And it was persisted like any other message.
    expect(reported.at(-1)).toBe(message);

    // The client hears it in the order a failed run always says it.
    const tail = events.slice(-4).map((e) => e.type);
    expect(tail).toEqual(["error", "message-end", "usage", "run-end"]);
    expect(events.at(-1)).toMatchObject({ type: "run-end", finishReason: "error" });
    expect(events.find((e) => e.type === "error")).toMatchObject({
      error: { code: "timeout", retryable: true },
    });

    // Logged like every failed run, and no timer outlives it.
    expect(logged.error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("result({ throwOnError: true }) rejects with the timeout", async () => {
    const { tool } = hungTool();
    const provider = fakeProvider([toolCall("c1", "lookup"), finish()]);
    const agent = Agent.create({
      name: "slowpoke",
      provider,
      tools: [tool],
      maxRunDurationMs: 1000,
      logErrors: false,
    });
    const settled = agent
      .stream({ messages: [] })
      .result({ throwOnError: true })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await settled;
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error.code).toBe("timeout");
    expect(logged.error).not.toHaveBeenCalled();
  });

  test("a provider that stops sending is cancelled at the deadline", async () => {
    const { provider, signals } = stallingProvider();
    const agent = Agent.create({ name: "waiting", provider, maxRunDurationMs: 5000 });
    const run = agent.stream({ messages: [] });

    await vi.advanceTimersByTimeAsync(5000);
    const result = await run.result();
    expect(result.finishReason).toBe("error");
    expect(result.error?.code).toBe("timeout");
    // The provider request itself is aborted, not just abandoned.
    expect(signals[0]!.aborted).toBe(true);
  });

  test("hit mid-stream, the message keeps the text it had and closes as an error", async () => {
    const { provider } = stallingProvider([
      { type: "text-delta", delta: "Let me " },
      { type: "text-delta", delta: "think" },
    ]);
    const agent = Agent.create({ name: "waiting", provider, maxRunDurationMs: 5000 });
    const run = agent.stream({ messages: [] });
    const { events, done } = collect(run);

    await vi.advanceTimersByTimeAsync(4000);
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await run.result();
    await done;

    expect(result.finishReason).toBe("error");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "Let me think" }]);
    expect(result.messages[0]!.finishReason).toBe("error");
    expect(events.find((e) => e.type === "message-end")).toMatchObject({ finishReason: "error" });
  });

  test("defaults to ten minutes", async () => {
    expect(DEFAULT_MAX_RUN_DURATION_MS).toBe(10 * 60 * 1000);
    const { tool } = hungTool();
    const provider = fakeProvider([toolCall("c1", "lookup"), finish()]);
    const agent = Agent.create({ name: "slowpoke", provider, tools: [tool], logErrors: false });
    expect(agent.maxRunDurationMs).toBe(DEFAULT_MAX_RUN_DURATION_MS);
    const run = agent.stream({ messages: [] });
    let ended = false;
    void run.result().then(() => (ended = true));

    await vi.advanceTimersByTimeAsync(DEFAULT_MAX_RUN_DURATION_MS - 1);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await run.result()).error?.code).toBe("timeout");
  });

  test("null turns it off, and a stream can override the agent's", async () => {
    const { tool } = hungTool();
    const provider = fakeProvider(
      [toolCall("c1", "lookup"), finish()],
      [toolCall("c2", "lookup"), finish()],
    );
    const agent = Agent.create({
      name: "slowpoke",
      provider,
      tools: [tool],
      maxRunDurationMs: null,
      logErrors: false,
    });
    expect(agent.maxRunDurationMs).toBeNull();

    const unbounded = agent.stream({ messages: [] });
    // No deadline timer at all: nothing to fire, nothing to clear.
    expect(vi.getTimerCount()).toBe(0);
    unbounded.stop();
    expect((await unbounded.result()).finishReason).toBe("aborted");

    const bounded = agent.stream({ messages: [], maxRunDurationMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await bounded.result()).error?.code).toBe("timeout");
  });

  test("a run that finishes in time clears its timer and is not an error", async () => {
    const provider = fakeProvider([{ type: "text-delta", delta: "hi" }, finish()]);
    const agent = Agent.create({ name: "quick", provider, maxRunDurationMs: 1000 });
    const result = await agent.stream({ messages: [] }).result();
    expect(result.finishReason).toBe("stop");
    expect(result.error).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stop() before the deadline is still an abort, not a timeout", async () => {
    const { tool } = hungTool();
    const provider = fakeProvider([toolCall("c1", "lookup"), finish()]);
    const agent = Agent.create({
      name: "slowpoke",
      provider,
      tools: [tool],
      maxRunDurationMs: 1000,
    });
    const run = agent.stream({ messages: [] });
    await vi.advanceTimersByTimeAsync(10);
    run.stop({ reason: "user" });
    const result = await run.result();
    expect(result.finishReason).toBe("aborted");
    expect(result.error).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a sub-run is bounded by its parent, and has no default of its own", async () => {
    // The sub-agent takes fifteen minutes, past the default, inside a parent
    // that allows an hour. It must not be cut off at ten.
    const work = AgentTool.create({
      name: "work",
      description: "Slow but honest",
      inputSchema: s.object({}),
      execute: () =>
        new Promise<string>((resolve) => setTimeout(() => resolve("done"), 15 * 60_000)),
    });
    const child = Agent.create({
      name: "child",
      provider: fakeProvider([toolCall("w1", "work"), finish()], [finish()]),
      tools: [work],
    });
    const delegate = AgentTool.create({
      name: "delegate",
      description: "Delegates",
      inputSchema: s.object({}),
      execute: async (_input, ctx) => (await ctx.runAgent(child, { prompt: "go" })).finishReason,
    });
    const parent = Agent.create({
      name: "parent",
      provider: fakeProvider([toolCall("d1", "delegate"), finish()], [finish()]),
      tools: [delegate],
      maxRunDurationMs: 60 * 60_000,
    });

    const run = parent.stream({ messages: [] });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const result = await run.result();
    expect(result.finishReason).toBe("stop");
    expect(results(result.messages)[0]).toMatchObject({ status: "ok", output: "stop" });

    // And the parent's own deadline reaches a sub-run that hangs.
    const { tool: hung } = hungTool();
    const stuck = Agent.create({
      name: "stuck",
      provider: fakeProvider([toolCall("h1", "lookup"), finish()]),
      tools: [hung],
    });
    const delegateStuck = AgentTool.create({
      name: "delegate",
      description: "Delegates",
      inputSchema: s.object({}),
      execute: async (_input, ctx) => (await ctx.runAgent(stuck, { prompt: "go" })).finishReason,
    });
    const bounded = Agent.create({
      name: "parent",
      provider: fakeProvider([toolCall("d1", "delegate"), finish()]),
      tools: [delegateStuck],
      maxRunDurationMs: 1000,
      logErrors: false,
    });
    const second = bounded.stream({ messages: [] });
    await vi.advanceTimersByTimeAsync(1000);
    const out = await second.result();
    expect(out.error?.code).toBe("timeout");
    const call = out.messages[0]!.content.find((p) => p.type === "tool-call") as any;
    // The sub-run was stopped and its transcript recorded on the call.
    expect(call.nested[0].finishReason).toBe("aborted");
  });

  test("a limit that is not a positive number is refused up front", () => {
    const provider = fakeProvider();
    expect(() => Agent.create({ name: "a", provider, maxRunDurationMs: 0 })).toThrow(/positive/);
    expect(() => Agent.create({ name: "a", provider, maxRunDurationMs: -5 })).toThrow(/positive/);
    expect(() =>
      Agent.create({ name: "a", provider }).stream({ messages: [], maxRunDurationMs: Number.NaN }),
    ).toThrow(/positive/);
    expect(Agent.create({ name: "a", provider, maxRunDurationMs: Infinity }).maxRunDurationMs).toBe(
      null,
    );
  });
});

describe("AgentTool timeoutMs", () => {
  test("a hung tool becomes a timeout result for the model, and the run carries on", async () => {
    const { tool, signals } = hungTool({ timeoutMs: 30_000 });
    const provider = fakeProvider(
      [toolCall("c1", "lookup"), finish()],
      [{ type: "text-delta", delta: "It timed out, sorry." }, finish()],
    );
    const agent = Agent.create({ name: "patient", provider, tools: [tool] });
    const run = agent.stream({ messages: [] });

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await run.result();

    expect(result.finishReason).toBe("stop");
    expect(result.error).toBeUndefined();
    expect(results(result.messages)).toEqual([
      {
        type: "tool-result",
        toolCallId: "c1",
        name: "lookup",
        status: "error",
        error: {
          code: "timeout",
          message: expect.stringContaining('"lookup" did not finish within 30s'),
          toolCallId: "c1",
          retryable: true,
        },
      },
    ]);
    // The tool's signal fired with a TimeoutError, as `AbortSignal.timeout`'s does.
    expect(signals[0]!.aborted).toBe(true);
    expect((signals[0]!.reason as DOMException).name).toBe("TimeoutError");
    // The model was asked again, with the timeout in its history.
    expect(provider.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a tool that honours the signal still reports the timeout, not its AbortError", async () => {
    const tool = AgentTool.create({
      name: "fetcher",
      description: "Fetches",
      inputSchema: s.object({}),
      timeoutMs: 100,
      execute: (_input, ctx) =>
        new Promise((_, reject) =>
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }),
        ),
    });
    const provider = fakeProvider([toolCall("c1", "fetcher"), finish()], [finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [tool] });
    const run = agent.stream({ messages: [] });
    await vi.advanceTimersByTimeAsync(100);
    const result = await run.result();
    expect(results(result.messages)).toHaveLength(1);
    expect(results(result.messages)[0]).toMatchObject({
      status: "error",
      error: { code: "timeout" },
    });
  });

  test("a generator that yields after its timeout puts nothing more on the stream", async () => {
    let tick!: () => void;
    const tool = AgentTool.create({
      name: "progressive",
      description: "Reports progress",
      inputSchema: s.object({}),
      timeoutMs: 1000,
      async *execute() {
        yield { pct: 10 };
        await new Promise<void>((resolve) => (tick = resolve));
        yield { pct: 90 };
        return "late";
      },
    });
    const provider = fakeProvider([toolCall("c1", "progressive"), finish()], [finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [tool] });
    const run = agent.stream({ messages: [] });
    const { events, done } = collect(run);

    await vi.advanceTimersByTimeAsync(1000);
    await run.result();
    // The body wakes up after the run has moved on.
    tick();
    await vi.advanceTimersByTimeAsync(0);
    await done;

    const progress = events.filter((e) => e.type === "tool-progress");
    expect(progress).toEqual([{ type: "tool-progress", toolCallId: "c1", data: { pct: 10 } }]);
    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ part: { status: "error", error: { code: "timeout" } } });
  });

  test("a tool that finishes in time is untouched and leaves no timer", async () => {
    const tool = AgentTool.create({
      name: "quick",
      description: "Quick",
      inputSchema: s.object({}),
      timeoutMs: 1000,
      execute: async () => "fast",
    });
    const provider = fakeProvider([toolCall("c1", "quick"), finish()], [finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [tool], maxRunDurationMs: null });
    const result = await agent.stream({ messages: [] }).result();
    expect(results(result.messages)[0]).toMatchObject({ status: "ok", output: "fast" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a stop while the tool runs is still a stop, not a timeout", async () => {
    const { tool, signals } = hungTool({ timeoutMs: 1000 });
    const provider = fakeProvider([toolCall("c1", "lookup"), finish()]);
    const agent = Agent.create({ name: "a", provider, tools: [tool] });
    const run = agent.stream({ messages: [] });
    await vi.advanceTimersByTimeAsync(10);
    run.stop({ reason: "user" });
    const result = await run.result();
    expect(result.finishReason).toBe("aborted");
    expect(results(result.messages)[0]).toMatchObject({ status: "denied", cause: "stopped" });
    // The run's stop reached the tool through the call's own signal.
    expect(signals[0]!.aborted).toBe(true);
  });

  test("a timeout that is not a positive number is refused up front", () => {
    expect(() =>
      AgentTool.create({
        name: "t",
        description: "t",
        inputSchema: s.object({}),
        timeoutMs: 0,
        execute: async () => null,
      }),
    ).toThrow(/positive/);
  });
});

/**
 * #617's durable turns, for a run that ran out of time: the turn is stored
 * finished, as an error, and a later process does not read it as interrupted.
 */
describe("a timed-out turn in the store", () => {
  function jsonRequest(body: unknown) {
    const raw = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return new HttpRequest(raw, {}, "api", "/chat");
  }

  test("is stored closed, with its call denied, and is not settled as interrupted later", async () => {
    const { tool } = hungTool();
    const provider = fakeProvider([toolCall("c1", "lookup"), finish()]);
    const agent = Agent.create({
      name: "slowpoke",
      provider,
      tools: [tool],
      maxRunDurationMs: 60_000,
      logErrors: false,
    });
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    const liveRuns = new MemoryLiveRuns();
    class Chat extends AgentController {
      agent = agent;
      store = store;
      liveRuns = liveRuns;
    }

    const response = await new Chat().stream(jsonRequest({ threadId, text: "look it up" }));
    const body = response.text();
    await vi.advanceTimersByTimeAsync(60_000);
    const sse = await body;
    expect(sse).toContain('"code":"timeout"');
    expect(sse).toContain('"finishReason":"error"');
    await vi.advanceTimersByTimeAsync(0);

    const held = (await store.loadThread(threadId))!;
    expect(held.map((m) => `${m.role}:${m.finishReason}`)).toEqual([
      "user:stop",
      "assistant:error",
    ]);
    const assistant = held[1]!;
    // Finished, so it carries no live run id for a reader to check.
    expect(assistant.runId).toBeUndefined();
    expect(assistant.content.map((p) => p.type)).toEqual(["tool-call", "tool-result"]);
    expect(results([assistant])[0]).toMatchObject({ status: "denied", cause: "stopped" });

    // Another process, none of this one's runs: nothing to settle.
    class Elsewhere extends Chat {
      liveRuns = new MemoryLiveRuns();
    }
    const read = (await new Elsewhere().readThread(threadId))!;
    expect(read).toEqual(held);
    liveRuns.clear();
  });
});
