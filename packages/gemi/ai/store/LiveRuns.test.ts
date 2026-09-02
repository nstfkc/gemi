import { describe, expect, test } from "vitest";

import type { AgentStreamEvent, AgentStreamFrame } from "../types";
import { FrameCursorEvictedError, LiveRunNotFoundError, MemoryLiveRuns } from "./LiveRuns";
import { StubAgentRun } from "./stubAgentRun";

const textDelta = (delta: string): AgentStreamEvent => ({
  type: "text-delta",
  messageId: "m1",
  delta,
});

/**
 * Lets the buffering pump catch up.
 *
 * The pump reads the run through an async generator, so a frame emitted on this
 * tick is buffered a few microtasks later. A macrotask is the cheap way to be
 * past all of them without counting.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function collect(frames: AsyncIterable<AgentStreamFrame>): Promise<AgentStreamFrame[]> {
  const out: AgentStreamFrame[] = [];
  for await (const frame of frames) {
    out.push(frame);
  }
  return out;
}

describe("MemoryLiveRuns", () => {
  test("finds a run by thread and hands the run itself back by id", async () => {
    const runs = new MemoryLiveRuns();
    const run = new StubAgentRun("run_a");
    runs.register(run, { threadId: "t1" });
    run.emit(textDelta("hi"));
    await settle();

    const found = await runs.find({ threadId: "t1" });
    expect(found).toEqual({ runId: "run_a", seq: 0 });
    expect(runs.get("run_a")).toBe(run);

    run.finish();
    runs.clear();
  });

  test("misses explicitly for a thread with nothing in flight here", async () => {
    const runs = new MemoryLiveRuns();
    expect(await runs.find({ threadId: "nobody" })).toBeNull();
    expect(runs.get("run_nowhere")).toBeNull();
    // The point of the whole class: behind a round-robin balancer this is what
    // a refresh hits, and it has to be a miss and not an empty stream.
    expect(() => runs.replay("run_nowhere", 0)).toThrow(LiveRunNotFoundError);
  });

  test("replays the whole run, then closes", async () => {
    const runs = new MemoryLiveRuns();
    const run = new StubAgentRun("run_b");
    runs.register(run, { threadId: "t1" });

    run.emit(textDelta("a"));
    run.emit(textDelta("b"));
    run.finish();

    const frames = await collect(runs.replay("run_b", 0));
    expect(frames.map((f) => f.seq)).toEqual([0, 1]);
    runs.clear();
  });

  test("replays exactly the tail from a cursor", async () => {
    const runs = new MemoryLiveRuns();
    const run = new StubAgentRun("run_c");
    runs.register(run, { threadId: "t1" });

    for (const chunk of ["a", "b", "c", "d"]) {
      run.emit(textDelta(chunk));
    }
    run.finish();

    const frames = await collect(runs.replay("run_c", 2));
    expect(frames.map((f) => f.seq)).toEqual([2, 3]);
    expect(frames.map((f) => (f.event as { delta: string }).delta)).toEqual(["c", "d"]);
    runs.clear();
  });

  test("keeps delivering frames that arrive after the reader attached", async () => {
    const runs = new MemoryLiveRuns();
    const run = new StubAgentRun("run_d");
    runs.register(run, { threadId: "t1" });
    run.emit(textDelta("a"));

    const collected = collect(runs.replay("run_d", 0));
    await settle();

    run.emit(textDelta("b"));
    run.finish();

    expect((await collected).map((f) => f.seq)).toEqual([0, 1]);
    runs.clear();
  });

  test("bounds the buffer, dropping the oldest frames", async () => {
    const runs = new MemoryLiveRuns({ maxFrames: 4 });
    const run = new StubAgentRun("run_e");
    runs.register(run, { threadId: "t1" });

    for (let i = 0; i < 10; i++) {
      run.emit(textDelta(String(i)));
    }
    run.finish();
    await settle();

    const frames = await collect(runs.replay("run_e", 6));
    expect(frames.map((f) => f.seq)).toEqual([6, 7, 8, 9]);
    runs.clear();
  });

  test("refuses a cursor the buffer has already dropped", async () => {
    const runs = new MemoryLiveRuns({ maxFrames: 4 });
    const run = new StubAgentRun("run_f");
    runs.register(run, { threadId: "t1" });

    for (let i = 0; i < 10; i++) {
      run.emit(textDelta(String(i)));
    }
    run.finish();
    await settle();

    // Not "here is the tail I still have": a client resuming at 0 and silently
    // receiving frame 6 onwards has a transcript with an invisible hole in it.
    let thrown: unknown;
    try {
      runs.replay("run_f", 0);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FrameCursorEvictedError);
    expect((thrown as FrameCursorEvictedError).requested).toBe(0);
    expect((thrown as FrameCursorEvictedError).oldest).toBe(6);
    runs.clear();
  });

  test("holds a finished run for ttlMs, then evicts it", async () => {
    const runs = new MemoryLiveRuns({ ttlMs: 10 });
    const run = new StubAgentRun("run_g");
    runs.register(run, { threadId: "t1" });
    run.emit(textDelta("a"));
    run.finish();

    // Still there right after the end — that is the "refresh a second late"
    // case the ttl exists for.
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await runs.find({ threadId: "t1" })).toEqual({ runId: "run_g", seq: 0 });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await runs.find({ threadId: "t1" })).toBeNull();
    expect(runs.get("run_g")).toBeNull();
    expect(runs.size).toBe(0);
  });

  test("feeds events to onEvent in order without blocking the buffer", async () => {
    const runs = new MemoryLiveRuns();
    const run = new StubAgentRun("run_h");
    const seen: string[] = [];
    runs.register(run, {
      threadId: "t1",
      onEvent: (event) => {
        seen.push(event.type);
      },
    });

    run.emit(textDelta("a"));
    run.emit({ type: "run-end", runId: "run_h", finishReason: "stop" });
    run.finish();

    await collect(runs.replay("run_h", 0));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(["text-delta", "run-end"]);
    runs.clear();
  });

  test("reports a throwing onEvent instead of losing the run", async () => {
    const runs = new MemoryLiveRuns();
    const run = new StubAgentRun("run_i");
    const failures: unknown[] = [];
    runs.register(run, {
      threadId: "t1",
      onEvent: () => {
        throw new Error("hook exploded");
      },
      onInternalError: (err) => failures.push(err),
    });

    run.emit(textDelta("a"));
    run.emit(textDelta("b"));
    run.finish();

    const frames = await collect(runs.replay("run_i", 0));
    expect(frames.map((f) => f.seq)).toEqual([0, 1]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(failures).toHaveLength(2);
    runs.clear();
  });
});
