process.env.SECRET ??= "agent-jobs-coordination-test-secret";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { QueueManager } from "../../services/queue/QueueManager";
import { Agent } from "../Agent";
import type { ProviderEvent } from "../AgentProvider";
import { fakeProvider } from "../providers/fakeProvider";
import type { AgentMessage } from "../types";
import { AgentJob, type AgentJobContext, AgentJobs } from "./AgentJob";
import { type AgentJobRecord, type AgentJobStore, MemoryAgentJobStore } from "./AgentJobStore";
import { renderJobsBlock } from "./contextBlock";

/**
 * Coordinating background jobs (#1222): `after` dependencies, server-started
 * jobs, cancellation that cascades, the inbox, checkpoints and batched
 * settles.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(check: () => boolean | Promise<boolean>, ms = 2_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await tick();
  }
}

/** Per-task gates: a job named in `held` runs until its gate is opened. */
const gates = new Map<string, { promise: Promise<void>; open: () => void }>();
function hold(task: string) {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  gates.set(task, { promise, open });
}
const release = (task: string) => gates.get(task)?.open();

/** What each attempt of a task saw, for the tests to read. */
let seen: { task: string; signal: AbortSignal; inbox: string[]; checkpointed: unknown }[];
let failTasks: Set<string>;

class TaskJob extends AgentJob<{ task: string }, { done: string }> {
  static name = "CoordinationTestTaskJob";
  maxAttempts = 1;
  cancelCheckMs = 20;

  async run({ task }: { task: string }, job: AgentJobContext) {
    const entry = {
      task,
      signal: job.signal,
      inbox: [] as string[],
      checkpointed: job.checkpointed,
    };
    seen.push(entry);
    const gate = gates.get(task);
    if (gate) {
      await Promise.race([
        gate.promise,
        new Promise<void>((_, reject) =>
          job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true }),
        ),
      ]);
    }
    entry.inbox.push(...(await job.inbox.take()));
    if (failTasks.has(task)) throw new Error(`${task} broke`);
    return { done: task };
  }
}

class CheckpointJob extends AgentJob<{ steps: number }, { resumedFrom: unknown }> {
  static name = "CoordinationTestCheckpointJob";
  maxAttempts = 2;
  backoff = 0;

  async run({ steps }: { steps: number }, job: AgentJobContext) {
    if (job.checkpointed === undefined) {
      await job.checkpoint({ step: steps - 1 });
      throw new Error("the process died");
    }
    return { resumedFrom: job.checkpointed };
  }
}

let queue: QueueManager;
let store: MemoryAgentJobStore;
let previousApp: Application | undefined;
let previousStore: AgentJobStore;
const offs: Array<() => void> = [];

beforeEach(() => {
  gates.clear();
  seen = [];
  failTasks = new Set();
  queue = new QueueManager({ jobs: [TaskJob, CheckpointJob] });
  previousApp = Application.getInstance();
  const application = new Application();
  application.instance(QueueManager, queue as never);
  Application.setInstance(application);
  previousStore = AgentJobs.store;
  store = new MemoryAgentJobStore();
  AgentJobs.use(store);
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
  AgentJobs.use(previousStore);
  Application.setInstance(previousApp);
  vi.restoreAllMocks();
});

const stateOf = async (id: string) => (await store.get(id))?.state;
const settled = (id: string) => until(async () => ["ok", "error"].includes((await stateOf(id))!));

describe("AgentJobs.start", () => {
  test("runs a job no tool call started, and settles it on its record", async () => {
    const handle = await AgentJobs.start(
      TaskJob,
      { task: "a" },
      { threadId: "t1", summary: { n: 1 } },
    );
    await settled(handle.id);
    expect(await store.get(handle.id)).toMatchObject({
      state: "ok",
      output: { done: "a" },
      threadId: "t1",
      toolCallId: "",
      runId: "",
      toolName: "CoordinationTestTaskJob",
      summary: { n: 1 },
    });
  });

  test("track records a job that something else settles", async () => {
    const handle = await AgentJobs.track<{ url: string }>({ name: "render video" });
    expect(await store.get(handle.id)).toMatchObject({
      state: "running",
      toolName: "render video",
    });
    expect(await AgentJobs.settle(handle.id, { output: { url: "u" } })).toBe(true);
    expect(await stateOf(handle.id)).toBe("ok");
  });
});

describe("after", () => {
  test("a job waits for the jobs it starts after, then starts with a fresh deadline", async () => {
    hold("a");
    const a = await AgentJobs.start(TaskJob, { task: "a" });
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id], deadlineMs: 5_000 });
    const waiting = (await store.get(b.id))!;
    expect(waiting).toMatchObject({ state: "waiting", after: [a.id] });
    await tick();
    expect(seen.map((s) => s.task)).toEqual(["a"]);

    release("a");
    await settled(b.id);
    expect(seen.map((s) => s.task)).toEqual(["a", "b"]);
    const done = (await store.get(b.id))!;
    expect(done).toMatchObject({ state: "ok", output: { done: "b" } });
    expect(done.deadlineAt).toBeGreaterThan(waiting.deadlineAt);
  });

  test("a job after one already done starts at once", async () => {
    const a = await AgentJobs.start(TaskJob, { task: "a" });
    await settled(a.id);
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id] });
    expect(await stateOf(b.id)).not.toBe("waiting");
    await settled(b.id);
  });

  test("a failed dependency cancels the jobs waiting for it, down the line", async () => {
    hold("a");
    failTasks.add("a");
    const a = await AgentJobs.start(TaskJob, { task: "a" });
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id] });
    const c = await AgentJobs.start(TaskJob, { task: "c" }, { after: [b.id] });
    const heard: AgentJobRecord[] = [];
    offs.push(AgentJobs.onSettled((job) => void heard.push(job)));

    release("a");
    await settled(c.id);
    expect((await store.get(b.id))!.error).toMatchObject({ code: "dependency_failed" });
    expect((await store.get(c.id))!.error).toMatchObject({ code: "dependency_failed" });
    expect((await store.get(c.id))!.error!.message).toContain(b.id);
    expect(seen.map((s) => s.task)).toEqual(["a"]);
    await until(() => heard.length === 3);
  });

  test("refuses a dependency that does not exist or already failed", async () => {
    await expect(
      AgentJobs.start(TaskJob, { task: "b" }, { after: ["ajob_missing"] }),
    ).rejects.toThrow(/does not exist/);
    const a = await AgentJobs.track();
    await AgentJobs.fail(a.id, "no");
    await expect(AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id] })).rejects.toThrow(
      /did not finish/,
    );
  });

  test("the sweep starts a waiting job whose dependencies settled unseen", async () => {
    const a = await AgentJobs.track();
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id] });
    // Settled behind the feature's back, as by a process that died before it
    // could start the jobs waiting.
    await store.transition(a.id, ["running"], { state: "ok", output: null });
    expect(await stateOf(b.id)).toBe("waiting");
    await AgentJobs.sweep();
    await settled(b.id);
    expect(await stateOf(b.id)).toBe("ok");
  });

  test("the jobs block shows what a waiting job waits for", async () => {
    const a = await AgentJobs.track({ threadId: "t1", name: "a" });
    await AgentJobs.start(TaskJob, { task: "b" }, { threadId: "t1", after: [a.id], name: "b" });
    const block = renderJobsBlock(await store.listForThread("t1"), 10)!;
    expect(block).toContain(`(b); waiting for ${a.id}`);
  });
});

describe("cancel", () => {
  test("aborts a running job's signal and cancels the jobs waiting for it", async () => {
    hold("a");
    const a = await AgentJobs.start(TaskJob, { task: "a" });
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id] });
    await until(() => seen.length === 1);
    const heard: string[] = [];
    offs.push(AgentJobs.onSettled((job) => void heard.push(job.id)));

    expect(await AgentJobs.cancel(a.id, { reason: "Stopped by the user." })).toBe(true);
    expect(seen[0]!.signal.aborted).toBe(true);
    expect((await store.get(a.id))!.error).toMatchObject({
      code: "cancelled",
      message: "Stopped by the user.",
    });
    expect((await store.get(b.id))!.error).toMatchObject({ code: "cancelled" });
    await until(() => heard.length === 2);
    // Settled already: a second cancel changes nothing.
    expect(await AgentJobs.cancel(a.id)).toBe(false);
  });

  test("silent tells no listener, for the job or the ones waiting for it", async () => {
    hold("a");
    const a = await AgentJobs.start(TaskJob, { task: "a" });
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id] });
    const heard: string[] = [];
    offs.push(AgentJobs.onSettled((job) => void heard.push(job.id)));
    await AgentJobs.cancel(a.id, { silent: true });
    expect(await stateOf(b.id)).toBe("error");
    const c = await AgentJobs.track();
    await AgentJobs.settle(c.id, { output: 1 });
    await until(() => heard.length > 0);
    expect(heard).toEqual([c.id]);
  });

  test("a job cancelled in another process notices on its next check", async () => {
    hold("a");
    const a = await AgentJobs.start(TaskJob, { task: "a" });
    await until(() => seen.length === 1);
    // What a cancel elsewhere leaves: the record, and no abort here.
    await store.transition(a.id, ["running"], {
      state: "error",
      error: { code: "cancelled", message: "x", retryable: false },
    });
    await until(() => seen[0]!.signal.aborted);
  });
});

describe("the inbox", () => {
  test("a waiting job gets its messages when it starts; a settled job takes none", async () => {
    hold("a");
    const a = await AgentJobs.start(TaskJob, { task: "a" });
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { after: [a.id] });
    expect(await AgentJobs.message(b.id, "use blue")).toBe(true);
    expect(await AgentJobs.message(a.id, "also the footer")).toBe(true);
    release("a");
    await settled(b.id);
    expect(seen.find((s) => s.task === "a")!.inbox).toEqual(["also the footer"]);
    expect(seen.find((s) => s.task === "b")!.inbox).toEqual(["use blue"]);
    expect(await AgentJobs.message(b.id, "too late")).toBe(false);
  });

  test("messages a job never took stay on its record", async () => {
    const a = await AgentJobs.track();
    await AgentJobs.message(a.id, "one");
    await AgentJobs.message(a.id, "two");
    await AgentJobs.settle(a.id, { output: null });
    expect((await store.get(a.id))!.inbox).toEqual(["one", "two"]);
  });

  test("an agent run adds what its inbox holds before each model call", async () => {
    const finish = (): ProviderEvent => ({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const provider = fakeProvider(
      [{ type: "tool-call", toolCallId: "c1", name: "noop", args: "{}" }, finish()],
      [{ type: "text-delta", delta: "ok" }, finish()],
    );
    const queued = ["make it blue"];
    let taken = 0;
    const reported: AgentMessage[] = [];
    const agent = Agent.create({
      name: "worker",
      provider,
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: {
            toJSONSchema: () => ({ type: "object", properties: {} }),
            safeParse: (value: unknown) => ({ ok: true, value }),
          },
          async execute() {
            return "done";
          },
        } as any,
      ],
    });
    const run = agent.stream({
      messages: [],
      turn: { text: "build it" },
      inbox: {
        take: () => {
          taken++;
          // Arrives while the first step runs.
          return taken === 2 ? queued.splice(0) : [];
        },
      },
      onMessage: (message) => void reported.push(message),
    });
    const result = await run.result();
    expect(taken).toBe(2);
    const second = provider.calls[1]!.messages;
    const last = second.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "text", text: "make it blue" }]);
    expect(
      result.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("make it blue")),
    ).toBe(true);
    expect(reported.some((m) => JSON.stringify(m.content).includes("make it blue"))).toBe(true);
  });
});

describe("checkpoint", () => {
  test("the next attempt reads what the last one saved", async () => {
    const handle = await AgentJobs.start(CheckpointJob, { steps: 3 });
    await settled(handle.id);
    expect(await store.get(handle.id)).toMatchObject({
      state: "ok",
      output: { resumedFrom: { step: 2 } },
      checkpoint: { step: 2 },
    });
  });
});

describe("onSettledBatch", () => {
  test("reports jobs settling close together in one call, by thread", async () => {
    const calls: { key: string; ids: string[] }[] = [];
    offs.push(
      AgentJobs.onSettledBatch(
        (jobs, key) => void calls.push({ key, ids: jobs.map((j) => j.id) }),
        { delayMs: 30 },
      ),
    );
    const a = await AgentJobs.track({ threadId: "t1" });
    const b = await AgentJobs.track({ threadId: "t1" });
    const c = await AgentJobs.track({ threadId: "t2" });
    await AgentJobs.settle(a.id, { output: 1 });
    await AgentJobs.settle(b.id, { output: 2 });
    await AgentJobs.settle(c.id, { output: 3 });
    await until(() => calls.length === 2);
    expect(calls).toContainEqual({ key: "t1", ids: [a.id, b.id] });
    expect(calls).toContainEqual({ key: "t2", ids: [c.id] });
  });

  test("a batch's job waits for its siblings that don't build on it", async () => {
    const calls: string[][] = [];
    offs.push(
      AgentJobs.onSettledBatch((jobs) => void calls.push(jobs.map((j) => j.id)), { delayMs: 10 }),
    );
    hold("a");
    hold("b");
    const a = await AgentJobs.start(TaskJob, { task: "a" }, { threadId: "t", batch: "1" });
    const b = await AgentJobs.start(TaskJob, { task: "b" }, { threadId: "t", batch: "1" });
    hold("c");
    const c = await AgentJobs.start(
      TaskJob,
      { task: "c" },
      { threadId: "t", batch: "1", after: [a.id] },
    );

    release("a");
    await settled(a.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // b is independent of a and still running: a's report waits for it.
    expect(calls).toEqual([]);

    release("b");
    await until(() => calls.length === 1);
    // c builds on a and is still running, so a and b are told together.
    expect(calls[0]).toEqual([a.id, b.id]);

    release("c");
    await until(() => calls.length === 2);
    expect(calls[1]).toEqual([c.id]);
  });

  test("hold keeps ready reports back until a flush", async () => {
    const calls: string[][] = [];
    let open = true;
    const subscription = AgentJobs.onSettledBatch(
      (jobs) => void calls.push(jobs.map((j) => j.id)),
      { delayMs: 5, hold: () => open },
    );
    offs.push(subscription);
    const a = await AgentJobs.track({ threadId: "t" });
    await AgentJobs.settle(a.id, { output: null });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual([]);
    open = false;
    subscription.flush("t", { now: true });
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual([a.id]);
  });

  test("hold answering a number looks again after that long", async () => {
    const calls: string[][] = [];
    let holds = 0;
    offs.push(
      AgentJobs.onSettledBatch((jobs) => void calls.push(jobs.map((j) => j.id)), {
        delayMs: 5,
        hold: () => (holds++ === 0 ? 30 : false),
      }),
    );
    const a = await AgentJobs.track({ threadId: "t" });
    await AgentJobs.settle(a.id, { output: null });
    await until(() => calls.length === 1);
    expect(holds).toBe(2);
  });
});
