process.env.SECRET ??= "database-agent-job-store-test-secret";

import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONNECTION } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { Application } from "../../foundation/Application";
import { HttpRequest } from "../../http/HttpRequest";
import { DatabaseQueueDriver } from "../../services/queue/DatabaseQueueDriver";
import { QueueManager } from "../../services/queue/QueueManager";
import { Agent, AgentTool } from "../Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "../AgentController";
import type { ProviderEvent } from "../AgentProvider";
import { fakeProvider } from "../providers/fakeProvider";
import type { Schema } from "../Schema";
import type { AgentMessage, ToolResultPart } from "../types";
import { AgentJob, type AgentJobContext, AgentJobs } from "./AgentJob";
import { AgentJobDeadlineSweep } from "./AgentJobDeadlineSweep";
import type { AgentJobStore, NewAgentJobRecord } from "./AgentJobStore";
import { DatabaseAgentJobStore } from "./DatabaseAgentJobStore";

/**
 * The database job store (#461, phase 2), against SQLite always and against
 * Postgres and MySQL when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set. Each
 * test gets tables of its own.
 *
 * "A restart" is a second `SQL` client, a second store and a second queue
 * manager on the same database, with the first worker gone mid-job: everything
 * a new process would bring except the address space.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

type Database = {
  dialect: Dialect;
  connect(): SQL;
  jobsTable: string;
  queueTable: string;
  dispose(): Promise<void>;
};

type Backend = { name: string; dialect: Dialect; prepare(): Promise<Database> };

const suffix = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

const sqlite: Backend = {
  name: "sqlite",
  dialect: "sqlite",
  async prepare() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-agent-jobs-"));
    const url = `sqlite://${join(dir, "jobs.db")}`;
    const clients: SQL[] = [];
    const connect = () => {
      const client = new SQL(url);
      clients.push(client);
      return client;
    };
    const first = connect();
    await new DatabaseAgentJobStore({ sql: first, dialect: "sqlite" }).createTable();
    await new DatabaseQueueDriver({ sql: first, dialect: "sqlite" }).createTable();
    return {
      dialect: "sqlite",
      connect,
      jobsTable: "gemi_agent_jobs",
      queueTable: "gemi_jobs",
      async dispose() {
        await Promise.all(clients.map((client) => client.close()));
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};

function server(name: string, dialect: Dialect, url: string): Backend {
  return {
    name,
    dialect,
    async prepare() {
      // Mixed case: a statement that forgot to quote would miss the table.
      const jobsTable = `AgentJobs_${suffix()}`;
      const queueTable = `Queue_${suffix()}`;
      const clients: SQL[] = [];
      const connect = () => {
        const client = new SQL(url);
        clients.push(client);
        return client;
      };
      const first = connect();
      await new DatabaseAgentJobStore({ sql: first, dialect }, { table: jobsTable }).createTable();
      await new DatabaseQueueDriver({ sql: first, dialect }, { table: queueTable }).createTable();
      const quote = (table: string) =>
        dialect === "mysql" || dialect === "mariadb" ? `\`${table}\`` : `"${table}"`;
      return {
        dialect,
        connect,
        jobsTable,
        queueTable,
        async dispose() {
          await first.unsafe(`DROP TABLE IF EXISTS ${quote(jobsTable)}`);
          await first.unsafe(`DROP TABLE IF EXISTS ${quote(queueTable)}`);
          await Promise.all(clients.map((client) => client.close()));
        },
      };
    },
  };
}

const backends: Backend[] = [
  sqlite,
  ...(POSTGRES_URL ? [server("postgres", "postgres", POSTGRES_URL)] : []),
  ...(MYSQL_URL ? [server("mysql", "mysql", MYSQL_URL)] : []),
];

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DatabaseAgentJobStore on the servers this run has no URL for", () => {
    test.skip(
      `postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
        `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}`,
      () => {},
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await sleep(10);
  }
}

const disposers: Array<() => Promise<void>> = [];
let previousStore: AgentJobStore | undefined;
let previousApp: Application | undefined | null = null;

afterEach(async () => {
  if (previousStore) AgentJobs.use(previousStore);
  previousStore = undefined;
  if (previousApp !== null) Application.setInstance(previousApp);
  previousApp = null;
  for (const dispose of disposers.splice(0)) await dispose();
  vi.restoreAllMocks();
});

function useStore(store: AgentJobStore) {
  previousStore ??= AgentJobs.store;
  AgentJobs.use(store);
}

function useQueue(queue: QueueManager) {
  if (previousApp === null) previousApp = Application.getInstance();
  const application = new Application();
  application.instance(QueueManager, queue as never);
  Application.setInstance(application);
}

function newJob(overrides: Partial<NewAgentJobRecord> = {}): NewAgentJobRecord {
  return {
    id: `ajob_${crypto.randomUUID()}`,
    threadId: "thread_1",
    runId: "run_1",
    toolCallId: `call_${suffix()}`,
    toolName: "render",
    owner: "user:1",
    job: "RenderJob",
    summary: { count: 2, name: "Ünïcode ✓" },
    attachmentScope: "user:1",
    deadlineMs: 60_000,
    ...overrides,
  };
}

// --- the model's side, for the restart tests ------------------------------

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

const anything = {
  toJSONSchema: () => ({ type: "object", properties: {}, additionalProperties: true }),
  safeParse: (value: unknown) => ({ ok: true, value }),
} as unknown as Schema<{ count: number }>;

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

function resultsOf(messages: AgentMessage[]): ToolResultPart[] {
  return messages.flatMap((message) =>
    message.content.filter((part): part is ToolResultPart => part.type === "tool-result"),
  );
}

for (const backend of backends) {
  describe(`DatabaseAgentJobStore on ${backend.name}`, () => {
    async function database() {
      const db = await backend.prepare();
      disposers.push(db.dispose);
      const store = (sql = db.connect()) =>
        new DatabaseAgentJobStore(
          { name: DEFAULT_CONNECTION, sql, dialect: backend.dialect },
          { table: db.jobsTable },
        );
      const driver = (sql = db.connect()) =>
        new DatabaseQueueDriver(
          { name: DEFAULT_CONNECTION, sql, dialect: backend.dialect },
          { table: db.queueTable },
        );
      return { db, store, driver };
    }

    test("writes, reads back and lists a thread's jobs newest first", async () => {
      const { store } = await database();
      const jobs = store();
      const first = await jobs.create(newJob({ id: "ajob_a" }));
      expect(first).toMatchObject({
        id: "ajob_a",
        state: "running",
        owner: "user:1",
        summary: { count: 2, name: "Ünïcode ✓" },
        attachmentScope: "user:1",
      });
      expect(first.deadlineAt - first.createdAt).toBe(60_000);
      expect(first.orphaned).toBeUndefined();
      expect(first.settledAt).toBeUndefined();
      await sleep(5);
      await jobs.create(newJob({ id: "ajob_b", owner: null, job: null, summary: undefined }));
      await jobs.create(newJob({ id: "ajob_other", threadId: "thread_2" }));

      const listed = await jobs.listForThread("thread_1");
      expect(listed.map((job) => job.id)).toEqual(["ajob_b", "ajob_a"]);
      expect(listed[0]).toMatchObject({ owner: null, job: null });
      expect(listed[0]!.summary).toBeUndefined();
      expect(await jobs.listForThread("thread_1", { limit: 1 })).toHaveLength(1);
      expect(await jobs.listForThread("thread_1", { states: [] })).toEqual([]);
      expect(await jobs.get("ajob_nope")).toBeNull();
    });

    test("transition is compare-and-set, and keeps the first settle", async () => {
      const { store } = await database();
      const jobs = store();
      const record = await jobs.create(newJob());
      expect(await jobs.transition(record.id, ["ok"], { state: "error" })).toBe(false);
      expect(
        await jobs.transition(record.id, ["running"], {
          state: "ok",
          output: { made: 2, nested: [1, "two"] },
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        }),
      ).toBe(true);
      expect(await jobs.transition(record.id, ["running"], { state: "error" })).toBe(false);
      const settled = (await jobs.get(record.id))!;
      expect(settled).toMatchObject({
        state: "ok",
        output: { made: 2, nested: [1, "two"] },
        usage: { totalTokens: 3 },
      });
      expect(settled.settledAt).toBeGreaterThanOrEqual(settled.createdAt);

      expect(await jobs.transition(record.id, ["running", "ok", "error"], { orphaned: true })).toBe(
        true,
      );
      expect((await jobs.get(record.id))!).toMatchObject({ state: "ok", orphaned: true });
    });

    test("settles racing from two processes: exactly one wins", async () => {
      const { store } = await database();
      const a = store();
      const b = store();
      const record = await a.create(newJob());
      useStore(a);
      const outcomes = await Promise.all([
        a.transition(record.id, ["running"], { state: "ok", output: 1 }),
        b.transition(record.id, ["running"], { state: "ok", output: 2 }),
        b.transition(record.id, ["running"], {
          state: "error",
          error: { code: "timeout", message: "x", retryable: true },
        }),
        a.transition(record.id, ["running"], { state: "ok", output: 3 }),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    test("overdue jobs, on the database's clock, and the sweep fails them for good", async () => {
      const { store } = await database();
      const jobs = store();
      useStore(jobs);
      const late = await jobs.create(newJob({ id: "ajob_late", deadlineMs: 1 }));
      await jobs.create(newJob({ id: "ajob_fine", deadlineMs: 60_000 }));
      await sleep(20);
      const now = await jobs.now();
      expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
      expect((await jobs.overdue(now, 10)).map((job) => job.id)).toEqual(["ajob_late"]);

      await new AgentJobDeadlineSweep().callback();
      expect(await jobs.get(late.id)).toMatchObject({ state: "error", error: { code: "timeout" } });
      expect((await jobs.get("ajob_fine"))!.state).toBe("running");
      // The worker finishing afterwards is refused.
      expect(await AgentJobs.settle(late.id, { output: { made: 1 } })).toBe(false);
      expect(await AgentJobs.sweep()).toBe(0);
    });

    test("prune removes settled jobs older than the cut, never running ones", async () => {
      const { store } = await database();
      const jobs = store();
      const done = await jobs.create(newJob());
      const running = await jobs.create(newJob());
      await jobs.transition(done.id, ["running"], { state: "ok", output: 1 });
      await sleep(20);
      expect(await jobs.prune(10)).toBe(1);
      expect(await jobs.get(done.id)).toBeNull();
      expect(await jobs.get(running.id)).not.toBeNull();
    });

    test.skipIf(backend.dialect === "sqlite")(
      "the record and its queued job commit together, or neither does",
      async () => {
        const { store, driver, db } = await database();
        const sql = db.connect();
        const jobs = store(sql);
        const queue = new QueueManager({ driver: driver(sql), jobs: [] });
        await queue.stop();

        const id = `ajob_${suffix()}`;
        await expect(
          jobs.transaction(async () => {
            await jobs.create(newJob({ id }));
            await queue.push(
              class extends AgentJob<unknown, unknown> {
                static name = "Never";
                async run() {
                  return null;
                }
              },
              JSON.stringify([{ jobId: id, args: null }]),
            );
            throw new Error("the tool failed after queuing");
          }),
        ).rejects.toThrow("the tool failed after queuing");
        expect(await jobs.get(id)).toBeNull();
        expect(await driver(sql).claim(10, { visibilityTimeoutMs: 1_000 })).toEqual([]);

        await jobs.transaction(async () => {
          await jobs.create(newJob({ id }));
          await queue.push(
            class extends AgentJob<unknown, unknown> {
              static name = "Kept";
              async run() {
                return null;
              }
            },
            JSON.stringify([{ jobId: id, args: null }]),
          );
        });
        expect(await jobs.get(id)).not.toBeNull();
        expect(await driver(sql).claim(10, { visibilityTimeoutMs: 1_000 })).toHaveLength(1);
      },
    );

    describe("across a restart, on the database queue driver", () => {
      const runs: string[] = [];

      class RestartJob extends AgentJob<{ count: number }, { made: number }> {
        static name = "AgentJobsRestartJob";
        maxAttempts = 3;
        async run({ count }: { count: number }, job: AgentJobContext) {
          runs.push(job.id);
          return { made: count };
        }
      }

      const render = AgentTool.create({
        name: "render",
        description: "Render some images",
        inputSchema: anything,
        async: { deadlineMs: 60_000 },
        async execute({ count }, ctx) {
          return ctx.jobs.start(RestartJob, { count }, { summary: { count } });
        },
      });

      function controller(provider: ReturnType<typeof fakeProvider>, threads: MemoryAgentStore) {
        class Chat extends AgentController {
          agent = Agent.create({ name: "chat", provider, tools: [render] }) as any;
          store = threads;
          // A new process: no run of the old one is live here.
          liveRuns = new MemoryLiveRuns();
        }
        return new Chat();
      }

      test("a job whose worker died mid-run is finished by the next process, and the thread reads it", async () => {
        runs.length = 0;
        const { store, driver } = await database();
        // The thread store stands in for a durable one: it survives the restart.
        const threads = new MemoryAgentStore();
        const { threadId } = await threads.createThread({});

        // Process 1: takes the turn and queues the job, but its queue never
        // gets to run it.
        const first = store();
        useStore(first);
        const queue1 = new QueueManager({ driver: driver(), jobs: [RestartJob] });
        await queue1.stop();
        useQueue(queue1);
        const provider = fakeProvider(
          callTool("call_1", "render", { count: 4 }),
          say("Rendering."),
          say("Here they are."),
        );
        await (
          await controller(provider, threads).stream(
            jsonRequest({ threadId, turn: { text: "go" } }),
          )
        ).text();
        const [record] = await first.listForThread(threadId);
        expect(record).toMatchObject({ state: "running", job: "AgentJobsRestartJob" });

        // Its worker claims the job and dies with it: no report, no heartbeat.
        const lease = 300;
        const [claimed] = await driver().claim(1, { visibilityTimeoutMs: lease });
        expect(claimed).toMatchObject({ name: "AgentJobsRestartJob", attempt: 1 });

        // Process 2: a new client, store and queue on the same database.
        const second = store();
        useStore(second);
        const queue2 = new QueueManager({
          driver: driver(),
          jobs: [RestartJob],
          pollInterval: 20,
          visibilityTimeout: 1_000,
        });
        disposers.unshift(async () => {
          await queue2.stop();
        });
        useQueue(queue2);
        queue2.start();
        await until(async () => (await second.get(record!.id))?.state === "ok");
        expect(runs).toEqual([record!.id]);

        const next = controller(provider, threads);
        await (await next.stream(jsonRequest({ threadId, turn: { text: "done?" } }))).text();
        expect(resultsOf(provider.calls[2]!.messages)[0]).toMatchObject({
          status: "ok",
          output: { made: 4 },
          job: { id: record!.id, summary: { count: 4 } },
        });
        expect(resultsOf((await threads.loadThread(threadId))!)[0]).toMatchObject({
          status: "ok",
          output: { made: 4 },
        });
      });

      test("a job nobody finished times out on the next process's load, and a late result is refused", async () => {
        const { store, driver } = await database();
        const threads = new MemoryAgentStore();
        const { threadId } = await threads.createThread({});
        const jobs = store();
        useStore(jobs);
        const queue = new QueueManager({ driver: driver(), jobs: [RestartJob] });
        await queue.stop();
        useQueue(queue);

        const slow = AgentTool.create({
          name: "render",
          description: "x",
          inputSchema: anything,
          async: { deadlineMs: 50 },
          async execute({ count }, ctx) {
            return ctx.jobs.start(RestartJob, { count });
          },
        });
        const provider = fakeProvider(
          callTool("call_1", "render", { count: 1 }),
          say("Rendering."),
          say("Sorry."),
        );
        class Chat extends AgentController {
          agent = Agent.create({ name: "chat", provider, tools: [slow] }) as any;
          store = threads;
          liveRuns = new MemoryLiveRuns();
        }
        await (await new Chat().stream(jsonRequest({ threadId, turn: { text: "go" } }))).text();
        await sleep(80);

        // A new process, with no cron: the load itself fails the overdue job.
        const restarted = store();
        useStore(restarted);
        class Again extends Chat {
          liveRuns = new MemoryLiveRuns();
        }
        await (await new Again().stream(jsonRequest({ threadId, turn: { text: "and?" } }))).text();
        const result = resultsOf(provider.calls[2]!.messages)[0]!;
        expect(result).toMatchObject({ status: "error", error: { code: "timeout" } });
        const [record] = await restarted.listForThread(threadId);
        expect(await AgentJobs.settle(record!.id, { output: { made: 1 } })).toBe(false);
      });
    });
  });
}
