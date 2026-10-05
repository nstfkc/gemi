process.env.SECRET ??= "agent-jobs-test-secret";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { HttpRequest } from "../../http/HttpRequest";
import { QueueManager } from "../../services/queue/QueueManager";
import { Agent, AgentTool } from "../Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "../AgentController";
import type { ProviderEvent } from "../AgentProvider";
import { fakeProvider } from "../providers/fakeProvider";
import { toolResultOutput } from "../providers/request";
import type { Schema } from "../Schema";
import { ToolError } from "../redact";
import type { AgentMessage, ToolResultPart } from "../types";
import { AgentJob, type AgentJobContext, AgentJobs, JobsRequireThreadError } from "./AgentJob";
import { type AgentJobStore, MemoryAgentJobStore } from "./AgentJobStore";

/**
 * Background jobs for agent tools (#461), phase 1: a tool hands its work to a
 * job, its result reads `running`, and the job's outcome replaces it when the
 * controller next loads the thread.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(check: () => boolean | Promise<boolean>, ms = 2_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await tick();
  }
}

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];
const callTool = (id: string, name: string, args: unknown): ProviderEvent[] => [
  { type: "tool-call", toolCallId: id, name, args: JSON.stringify(args) },
  finish(),
];

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

function schemaOf<T>(check: (value: any) => string[]): Schema<T> {
  return {
    toJSONSchema: () => ({ type: "object", properties: {}, additionalProperties: true }),
    safeParse: (value: unknown) => {
      const errors = check(value);
      return errors.length ? { ok: false, errors } : { ok: true, value: value as T };
    },
  } as unknown as Schema<T>;
}

const inputSchema = schemaOf<{ count: number }>(() => []);

/** The job's body, swapped per test. */
let body: (args: { count: number }, job: AgentJobContext) => Promise<{ made: number }>;
/** Lets a test hold the job until it says so. */
let gate: Promise<void>;
let open: () => void;

class RenderJob extends AgentJob<{ count: number }, { made: number }> {
  static name = "AgentJobsTestRenderJob";
  maxAttempts = 2;

  async run(args: { count: number }, job: AgentJobContext) {
    await gate;
    return body(args, job);
  }
}

const render = AgentTool.create({
  name: "render",
  description: "Render some images",
  inputSchema,
  outputSchema: schemaOf<{ made: number }>((value) =>
    typeof value?.made === "number" ? [] : ["made: expected a number"],
  ),
  async: { deadlineMs: 60_000 },
  async execute({ count }, ctx) {
    return ctx.jobs.start(RenderJob, { count }, { summary: { count } });
  },
});

let queue: QueueManager;
let store: MemoryAgentJobStore;
let previousApp: Application | undefined;
let previousStore: AgentJobStore;

beforeEach(() => {
  gate = Promise.resolve();
  open = () => {};
  body = async ({ count }) => ({ made: count });
  queue = new QueueManager({ jobs: [RenderJob] });
  previousApp = Application.getInstance();
  const application = new Application();
  application.instance(QueueManager, queue as never);
  Application.setInstance(application);
  previousStore = AgentJobs.store;
  store = new MemoryAgentJobStore();
  AgentJobs.use(store);
});

afterEach(() => {
  AgentJobs.use(previousStore);
  Application.setInstance(previousApp);
  vi.restoreAllMocks();
});

function holdJobs() {
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
}

function setup(scripts: ProviderEvent[][], tools: AgentTool<any, any, any, any>[] = [render]) {
  const provider = fakeProvider(...scripts);
  const agentStore = new MemoryAgentStore();
  const reported: unknown[] = [];
  class Chat extends AgentController {
    agent = Agent.create({ name: "chat", provider, tools }) as any;
    store = agentStore;
    liveRuns = new MemoryLiveRuns();
    protected reportHookFailure(err: unknown) {
      reported.push(err);
    }
  }
  return { controller: new Chat(), provider, agentStore, reported };
}

function resultsOf(messages: AgentMessage[]): ToolResultPart[] {
  return messages.flatMap((message) =>
    message.content.filter((part): part is ToolResultPart => part.type === "tool-result"),
  );
}

async function turn(controller: AgentController, threadId: string | undefined, text: string) {
  const response = await controller.stream(
    jsonRequest(threadId ? { threadId, turn: { text } } : { messages: [], turn: { text } }),
  );
  return response.text();
}

describe("a tool that returns a job handle", () => {
  test("records a running result, and the next turn reads the job's output in its place", async () => {
    holdJobs();
    const { controller, provider, agentStore } = setup([
      callTool("call_1", "render", { count: 3 }),
      say("Started."),
      say("Done."),
    ]);
    const { threadId } = await agentStore.createThread({});

    await turn(controller, threadId, "make three");

    // The model was told the job started, in the same run.
    const second = provider.calls[1]!.messages;
    const running = resultsOf(second)[0]!;
    expect(running.status).toBe("running");
    expect(toolResultOutput(running)).toMatch(/still running.*Do not start it again/);

    const [record] = await store.listForThread(threadId);
    expect(record).toMatchObject({
      state: "running",
      toolCallId: "call_1",
      toolName: "render",
      job: "AgentJobsTestRenderJob",
      summary: { count: 3 },
    });
    expect(running).toMatchObject({ job: { id: record!.id, summary: { count: 3 } } });

    open();
    await until(async () => (await store.get(record!.id))?.state === "ok");

    await turn(controller, threadId, "and?");
    const third = provider.calls[2]!.messages;
    expect(resultsOf(third)[0]).toMatchObject({
      status: "ok",
      output: { made: 3 },
      job: { id: record!.id },
    });

    // Written back under the lock: the store holds the settled result now.
    const stored = (await agentStore.loadThread(threadId))!;
    expect(resultsOf(stored)[0]).toMatchObject({ status: "ok", output: { made: 3 } });
  });

  test("a settle that lands while the run is still persisting is not lost", async () => {
    // The job finishes before the run that started it has stored its
    // transcript. The run then writes its `running` copy over the message,
    // which is fine: the job's state is not in the message, and the next load
    // renders it.
    let release!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, provider, agentStore } = setup([
      callTool("call_1", "render", { count: 2 }),
      say("Started."),
      say("Done."),
    ]);
    const script = provider.stream.bind(provider);
    provider.stream = (params) =>
      (async function* () {
        // Hold the run's second step until the job has settled.
        if (provider.calls.length === 1) await modelGate;
        yield* script(params);
      })();
    const { threadId } = await agentStore.createThread({});

    const response = controller.stream(jsonRequest({ threadId, turn: { text: "go" } }));
    await until(async () => (await store.listForThread(threadId))[0]?.state === "ok");
    release();
    await (await response).text();
    await tick();

    // The run's own write still says running.
    const stored = (await agentStore.loadThread(threadId))!;
    expect(resultsOf(stored)[0]!.status).toBe("running");

    // A read renders the settled job without writing.
    const read = (await controller.readThread(threadId))!;
    expect(resultsOf(read)[0]).toMatchObject({ status: "ok", output: { made: 2 } });
    expect(resultsOf((await agentStore.loadThread(threadId))!)[0]!.status).toBe("running");

    // The next turn writes it back.
    await turn(controller, threadId, "next");
    expect(resultsOf((await agentStore.loadThread(threadId))!)[0]).toMatchObject({
      status: "ok",
      output: { made: 2 },
    });
  });

  test("a job that throws on its last attempt settles as an error the model can read, redacted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    body = async () => {
      throw new Error("connection to db.internal:5432 refused");
    };
    const { controller, provider, agentStore } = setup([
      callTool("call_1", "render", { count: 1 }),
      say("Started."),
      say("Sorry."),
    ]);
    const { threadId } = await agentStore.createThread({});
    await turn(controller, threadId, "go");

    const [record] = await store.listForThread(threadId);
    await until(async () => (await store.get(record!.id))?.state === "error");
    const failed = (await store.get(record!.id))!;
    expect(failed.error!.message).not.toContain("db.internal");
    expect(errors).toHaveBeenCalled();

    await turn(controller, threadId, "and?");
    const result = resultsOf(provider.calls[2]!.messages)[0]!;
    expect(result).toMatchObject({ status: "error", error: { code: "tool_error" } });
  });

  test("a ToolError's message reaches the model as written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    body = async () => {
      throw new ToolError("The page has no image slots.", { retryable: false });
    };
    const { controller, agentStore } = setup([
      callTool("call_1", "render", { count: 1 }),
      say("x"),
    ]);
    const { threadId } = await agentStore.createThread({});
    await turn(controller, threadId, "go");
    const [record] = await store.listForThread(threadId);
    await until(async () => (await store.get(record!.id))?.state === "error");
    expect((await store.get(record!.id))!.error).toMatchObject({
      message: "The page has no image slots.",
      retryable: false,
    });
  });

  test("an output that does not match the tool's output schema is an error", async () => {
    body = async () => ({ made: "lots" }) as any;
    const { controller, provider, agentStore } = setup([
      callTool("call_1", "render", { count: 1 }),
      say("x"),
      say("y"),
    ]);
    const { threadId } = await agentStore.createThread({});
    await turn(controller, threadId, "go");
    const [record] = await store.listForThread(threadId);
    await until(async () => (await store.get(record!.id))?.state === "ok");
    await turn(controller, threadId, "and?");
    expect(resultsOf(provider.calls[2]!.messages)[0]).toMatchObject({
      status: "error",
      error: { code: "invalid_tool_result" },
    });
  });

  test("a job the store no longer has reads as lost", async () => {
    holdJobs();
    const { controller, provider, agentStore } = setup([
      callTool("call_1", "render", { count: 1 }),
      say("x"),
      say("y"),
    ]);
    const { threadId } = await agentStore.createThread({});
    await turn(controller, threadId, "go");
    // A restart with the memory store: every record is gone.
    AgentJobs.use(new MemoryAgentJobStore());
    await turn(controller, threadId, "and?");
    const result = resultsOf(provider.calls[2]!.messages)[0]!;
    expect(result).toMatchObject({ status: "error" });
    expect(toolResultOutput(result)).toMatch(/can no longer be found/);
    open();
  });
});

describe("settling", () => {
  async function tracked(threadId = "thread_1") {
    return store.create({
      id: `ajob_${crypto.randomUUID()}`,
      threadId,
      runId: "run_1",
      toolCallId: "call_1",
      toolName: "render",
      owner: null,
      job: null,
      attachmentScope: null,
      deadlineMs: 60_000,
    });
  }

  test("the first settle wins and a second one changes nothing", async () => {
    const record = await tracked();
    expect(await AgentJobs.settle(record.id, { output: { made: 1 } })).toBe(true);
    expect(await AgentJobs.settle(record.id, { output: { made: 2 } })).toBe(false);
    expect(await AgentJobs.fail(record.id, "too late")).toBe(false);
    expect(await store.get(record.id)).toMatchObject({ state: "ok", output: { made: 1 } });
  });

  test("a result after the job was failed (by the deadline sweep, say) is refused", async () => {
    const record = await tracked();
    expect(
      await AgentJobs.fail(record.id, {
        code: "timeout",
        message: "It did not finish in time.",
        retryable: true,
      }),
    ).toBe(true);
    expect(await AgentJobs.settle(record.id, { output: { made: 1 } })).toBe(false);
    expect(await store.get(record.id)).toMatchObject({
      state: "error",
      error: { code: "timeout" },
    });
  });

  test("two settles racing: exactly one wins", async () => {
    const record = await tracked();
    const outcomes = await Promise.all([
      AgentJobs.settle(record.id, { output: { made: 1 } }),
      AgentJobs.settle(record.id, { output: { made: 2 } }),
      AgentJobs.fail(record.id, "lost the race"),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  test("an unknown id is false", async () => {
    expect(await AgentJobs.settle("ajob_nope", { output: 1 })).toBe(false);
  });

  test("usage given with the outcome is kept on the job and shown on the settled result", async () => {
    const record = await tracked();
    await AgentJobs.settle(record.id, {
      output: { made: 1 },
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect((await store.get(record.id))!.usage).toMatchObject({ totalTokens: 7 });
  });
});

describe("ctx.jobs.track", () => {
  test("records a job something else settles", async () => {
    let id = "";
    const watch = AgentTool.create({
      name: "watch",
      description: "Start a video render at a provider",
      inputSchema,
      async: {},
      async execute(_input, ctx) {
        const handle = await ctx.jobs.track<{ url: string }>({ summary: { kind: "video" } });
        id = handle.id;
        return handle;
      },
    });
    const { controller, provider, agentStore } = setup(
      [callTool("call_1", "watch", { count: 1 }), say("x"), say("y")],
      [watch],
    );
    const { threadId } = await agentStore.createThread({});
    await turn(controller, threadId, "go");
    expect((await store.get(id))!.job).toBeNull();

    // The provider's webhook.
    expect(await AgentJobs.settle(id, { output: { url: "https://cdn/x.mp4" } })).toBe(true);
    await turn(controller, threadId, "and?");
    expect(resultsOf(provider.calls[2]!.messages)[0]).toMatchObject({
      status: "ok",
      output: { url: "https://cdn/x.mp4" },
    });
  });
});

describe("where a job cannot start", () => {
  test("a stateless turn: the model reads jobs_require_thread's message as the tool's error", async () => {
    const { controller, provider } = setup([callTool("call_1", "render", { count: 1 }), say("x")]);
    await turn(controller, undefined, "go");
    const result = resultsOf(provider.calls[1]!.messages)[0]!;
    expect(result).toMatchObject({ status: "error", error: { code: "tool_error" } });
    expect(toolResultOutput(result)).toMatch(/conversation the server keeps/);
    expect(new JobsRequireThreadError("x").code).toBe("jobs_require_thread");
  });

  test("a tool that does not declare async", async () => {
    const plain = AgentTool.create({
      name: "plain",
      description: "x",
      inputSchema,
      async execute(_input, ctx) {
        return ctx.jobs.track();
      },
    });
    const { controller, provider, agentStore } = setup(
      [callTool("call_1", "plain", { count: 1 }), say("x")],
      [plain],
    );
    const { threadId } = await agentStore.createThread({});
    await turn(controller, threadId, "go");
    expect(toolResultOutput(resultsOf(provider.calls[1]!.messages)[0]!)).toMatch(
      /does not declare `async`/,
    );
  });

  test("a client tool cannot be async", () => {
    expect(() =>
      AgentTool.create({
        name: "client",
        description: "x",
        inputSchema,
        outputSchema: inputSchema,
        answeredBy: "client",
        async: {},
      } as any),
    ).toThrow(/cannot be `async`/);
  });
});

describe("orphans", () => {
  test("a job whose tool result never reached the thread is marked once its run is gone", async () => {
    const { controller, agentStore } = setup([say("hello")]);
    const { threadId } = await agentStore.createThread({});
    // The run died after `start` and before the journal stored the result.
    const record = await store.create({
      id: "ajob_orphan",
      threadId,
      runId: "run_dead",
      toolCallId: "call_lost",
      toolName: "render",
      owner: null,
      job: null,
      attachmentScope: null,
      deadlineMs: 60_000,
    });

    // A read does not write.
    await controller.readThread(threadId);
    expect((await store.get(record.id))!.orphaned).toBeUndefined();

    await turn(controller, threadId, "hi");
    expect((await store.get(record.id))!.orphaned).toBe(true);
    // It still settles: the work is not thrown away, only unanchored.
    expect(await AgentJobs.settle(record.id, { output: { made: 1 } })).toBe(true);
  });

  test("a job whose run is still live is not an orphan", async () => {
    holdJobs();
    let release!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, provider, agentStore } = setup([
      callTool("call_1", "render", { count: 1 }),
      say("Started."),
    ]);
    const script = provider.stream.bind(provider);
    provider.stream = (params) =>
      (async function* () {
        if (provider.calls.length === 1) await modelGate;
        yield* script(params);
      })();
    const { threadId } = await agentStore.createThread({});
    const response = controller.stream(jsonRequest({ threadId, turn: { text: "go" } }));
    await until(async () => (await store.listForThread(threadId)).length === 1);
    await controller.readThread(threadId);
    const [record] = await store.listForThread(threadId);
    expect(record!.orphaned).toBeUndefined();
    release();
    await (await response).text();
    open();
  });
});

describe("MemoryAgentJobStore", () => {
  test("transition is compare-and-set, and stamps settledAt once", async () => {
    const jobs = new MemoryAgentJobStore();
    const record = await jobs.create({
      id: "ajob_1",
      threadId: "t",
      runId: "r",
      toolCallId: "c",
      toolName: "x",
      owner: "user:1",
      job: null,
      attachmentScope: null,
      deadlineMs: 1_000,
    });
    expect(record.state).toBe("running");
    expect(record.deadlineAt - record.createdAt).toBe(1_000);
    expect(await jobs.transition("ajob_1", ["ok"], { state: "error" })).toBe(false);
    expect(await jobs.transition("ajob_1", ["running"], { state: "ok", output: 1 })).toBe(true);
    const settled = (await jobs.get("ajob_1"))!;
    expect(settled.settledAt).toBeTypeOf("number");
    expect(await jobs.transition("ajob_1", ["running"], { state: "error" })).toBe(false);
  });

  test("lists a thread's jobs newest first, filtered and bounded, and finds overdue ones", async () => {
    const jobs = new MemoryAgentJobStore();
    const make = (id: string, deadlineMs: number) =>
      jobs.create({
        id,
        threadId: "t",
        runId: "r",
        toolCallId: id,
        toolName: "x",
        owner: null,
        job: null,
        attachmentScope: null,
        deadlineMs,
      });
    await make("a", 1);
    await tick();
    await make("b", 60_000);
    await jobs.transition("b", ["running"], { state: "ok" });
    expect((await jobs.listForThread("t")).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await jobs.listForThread("t", { states: ["running"] })).map((r) => r.id)).toEqual([
      "a",
    ]);
    expect(await jobs.listForThread("t", { limit: 1 })).toHaveLength(1);
    expect((await jobs.overdue(Date.now(), 10)).map((r) => r.id)).toEqual(["a"]);
  });
});
