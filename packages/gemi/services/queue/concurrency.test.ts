import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import { DatabaseQueueDriver } from "./DatabaseQueueDriver";
import { Job } from "./Job";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import type { ClaimedJob, QueueDriver } from "./QueueDriver";
import { QueueManager } from "./QueueManager";
import type { Step } from "./workflow/Step";
import { Workflow } from "./workflow/Workflow";

/**
 * Concurrency limits (#1319) on every driver that has them: the memory
 * driver, and the database driver on SQLite always and on Postgres and MySQL
 * when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set. On a database "two
 * processes" is two `QueueManager`s over two clients, as in
 * `DatabaseQueueDriver.test.ts`.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await sleep(10);
  }
}

type Storage = {
  /** A driver over the storage: a new client each time on a database. */
  driver(): QueueDriver;
  /**
   * Whether two managers can run as two processes here. Not on SQLite: its
   * two clients in one test share the JavaScript thread, and one blocked in
   * SQLite's busy handler stops the other from finishing the transaction it
   * waits for (as `workflowContract`'s `concurrentWorkers` notes).
   */
  shared: boolean;
  dispose(): Promise<void>;
};

type Backend = { name: string; prepare(): Promise<Storage> };

const SUFFIXES = [
  "",
  "_batches",
  "_slots",
  "_workflows",
  "_workflow_steps",
  "_workflow_items",
  "_workflow_sources",
];

function database(
  name: string,
  dialect: Dialect,
  url: () => { url: string; cleanup?: () => void },
): Backend {
  return {
    name,
    async prepare() {
      const target = url();
      const table =
        dialect === "sqlite"
          ? "gemi_jobs"
          : `GemiJobs_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const clients: SQL[] = [];
      const connect = () => {
        const client = new SQL(target.url);
        clients.push(client);
        return client;
      };
      const first = connect();
      await new DatabaseQueueDriver({ sql: first, dialect }, { table }).createTable();
      return {
        shared: dialect !== "sqlite",
        driver: () => new DatabaseQueueDriver({ sql: connect(), dialect }, { table }),
        async dispose() {
          if (dialect !== "sqlite") {
            const mysql = dialect === "mysql";
            for (const suffix of SUFFIXES) {
              const quoted = mysql ? `\`${table}${suffix}\`` : `"${table}${suffix}"`;
              await first.unsafe(`DROP TABLE IF EXISTS ${quoted}`);
            }
          }
          await Promise.all(clients.map((client) => client.close()));
          target.cleanup?.();
        },
      };
    },
  };
}

const backends: Backend[] = [
  {
    name: "memory",
    async prepare() {
      const driver = new MemoryQueueDriver();
      return { shared: false, driver: () => driver, dispose: async () => {} };
    },
  },
  database("sqlite", "sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "gemi-slots-"));
    return {
      url: `sqlite://${join(dir, "jobs.db")}`,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }),
  ...(POSTGRES_URL ? [database("postgres", "postgres", () => ({ url: POSTGRES_URL }))] : []),
  ...(MYSQL_URL ? [database("mysql", "mysql", () => ({ url: MYSQL_URL }))] : []),
];

describe.each(backends)("concurrency on $name", (backend) => {
  let storage: Storage | undefined;
  const managers: QueueManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.drain(5_000)));
    await Promise.all(managers.map((manager) => manager.workflows.close()));
    await storage?.dispose();
    storage = undefined;
  });

  async function open() {
    storage = await backend.prepare();
    return storage;
  }

  /** A manager over its own driver: on a database, its own process. */
  function worker(
    store: Storage,
    jobs: Array<new () => Job>,
    config: { workflows?: Array<typeof Workflow & { name: string }>; [key: string]: unknown } = {},
  ) {
    const manager = new QueueManager({
      driver: store.driver(),
      jobs,
      concurrency: 8,
      pollInterval: 20,
      ...config,
    } as never);
    managers.push(manager);
    manager.start();
    return manager;
  }

  /** The managers a test runs: two on a shared storage, one on the memory driver. */
  function workers(store: Storage, jobs: Array<new () => Job>, config = {}) {
    const first = worker(store, jobs, config);
    return store.shared ? [first, worker(store, jobs, config)] : [first];
  }

  test(
    "at most `limit` run at once per key, first come first served",
    { timeout: 30_000 },
    async () => {
      const store = await open();
      const started: number[] = [];
      let running = 0;
      let most = 0;
      class Import extends Job {
        static name = "Import";
        concurrency() {
          return { key: "import", limit: 1 };
        }
        async run(n: number) {
          started.push(n);
          running++;
          most = Math.max(most, running);
          await sleep(40);
          running--;
        }
      }
      // One process: the order is the order jobs first asked for a slot, and
      // with a second process claiming too, that can differ from the order
      // they were dispatched in by however long a claim takes. The second
      // process is in "two processes share one line".
      const queue = worker(store, [Import]);
      for (let n = 0; n < 6; n++) {
        await queue.push(Import, JSON.stringify([n]));
        await sleep(25);
      }
      await until(() => started.length === 6 && running === 0);
      expect(most).toBe(1);
      expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    },
  );

  test(
    "a waiting job is parked, not polled, and holds no queue slot",
    { timeout: 30_000 },
    async () => {
      const store = await open();
      const order: string[] = [];
      class Slow extends Job {
        static name = "Slow";
        concurrency() {
          return { key: "slow", limit: 1 };
        }
        async run(n: number) {
          order.push(`slow:${n}`);
          await sleep(150);
        }
      }
      class Fast extends Job {
        static name = "Fast";
        run() {
          order.push("fast");
        }
      }
      const queue = worker(store, [Slow, Fast], { concurrency: 2 });
      const driver = queue.driver;
      let admissions = 0;
      const acquire = driver.acquireSlots!.bind(driver);
      driver.acquireSlots = (request) => {
        admissions++;
        return acquire(request);
      };
      for (let n = 0; n < 4; n++) await queue.push(Slow, JSON.stringify([n]));
      await sleep(50);
      // Three slow jobs are waiting and the queue runs two at a time: a fast
      // job still gets a slot at once.
      await queue.push(Fast, "[]");
      await until(() => order.includes("fast"));
      // Dispatched together and claimed together, they asked in whatever
      // order their admissions reached the line; the FIFO test spaces them.
      expect(order.filter((entry) => entry.startsWith("slow"))).toHaveLength(1);
      await until(() => order.length === 5, 20_000);
      expect(order.filter((entry) => entry.startsWith("slow")).sort()).toEqual([
        "slow:0",
        "slow:1",
        "slow:2",
        "slow:3",
      ]);
      // Each waiter is admitted when it first asks and once more when woken,
      // not once per poll (the run took ~600ms at a 20ms poll).
      expect(admissions).toBeLessThanOrEqual(4 * 3);
    },
  );

  test("several limits: per key and overall", { timeout: 30_000 }, async () => {
    const store = await open();
    const running = new Map<string, number>();
    let total = 0;
    let most = 0;
    let mostPerOrg = 0;
    let done = 0;
    class Sync extends Job {
      static name = "Sync";
      async concurrency(org: string) {
        return [
          { key: `sync:${org}`, limit: 1 },
          { key: "sync", limit: 2 },
        ];
      }
      async run(org: string) {
        running.set(org, (running.get(org) ?? 0) + 1);
        total++;
        most = Math.max(most, total);
        mostPerOrg = Math.max(mostPerOrg, running.get(org)!);
        await sleep(200); // long enough that two overlap even when claims are slow
        running.set(org, running.get(org)! - 1);
        total--;
        done++;
      }
    }
    const [queue] = workers(store, [Sync]);
    for (const org of ["a", "a", "a", "b", "b", "c", "c", "d"]) {
      await queue!.push(Sync, JSON.stringify([org]));
    }
    await until(() => done === 8, 20_000);
    expect(mostPerOrg).toBe(1);
    expect(most).toBe(2);
  });

  test(
    "the limit is read when the job is admitted, and a raised one is seen",
    { timeout: 30_000 },
    async () => {
      const store = await open();
      let limit = 0;
      let done = 0;
      let running = 0;
      let most = 0;
      class Setting extends Job {
        static name = "Setting";
        async concurrency() {
          await sleep(1);
          return { key: "setting", limit };
        }
        async run() {
          running++;
          most = Math.max(most, running);
          await sleep(200); // long enough that two overlap even when claims are slow
          running--;
          done++;
        }
      }
      // The first waiter re-checks after the visibility timeout, which is
      // what sees a limit raised with nothing else happening on the key.
      const queue = worker(store, [Setting], { visibilityTimeout: 1000 });
      for (let n = 0; n < 4; n++) await queue.push(Setting, "[]");
      await sleep(300);
      expect(done).toBe(0);
      limit = 2;
      await until(() => done === 4, 10_000);
      expect(most).toBe(2);
    },
  );

  test(
    "a failed attempt frees its slot, and the retry queues again",
    { timeout: 30_000 },
    async () => {
      const store = await open();
      const runs: string[] = [];
      let thrown = false;
      class Flaky extends Job {
        static name = "Flaky";
        maxAttempts = 2;
        concurrency() {
          return { key: "flaky", limit: 1 };
        }
        async run(n: number) {
          runs.push(`${n}`);
          await sleep(20);
          if (n === 0 && !thrown) {
            thrown = true;
            throw new Error("once");
          }
        }
      }
      const [queue] = workers(store, [Flaky]);
      for (let n = 0; n < 3; n++) await queue!.push(Flaky, JSON.stringify([n]));
      await until(() => runs.length === 4, 20_000);
      expect(runs.filter((run) => run === "0")).toHaveLength(2);
    },
  );

  test(
    "a holder that is gone frees its slot at the line's next step",
    { timeout: 30_000 },
    async () => {
      const store = await open();
      const driver = store.driver();
      const claimOne = async () => {
        const [job] = await driver.claim(1, { visibilityTimeoutMs: 60_000 });
        return job!;
      };
      const ask = (job: ClaimedJob) =>
        driver.acquireSlots!({
          holder: job.id,
          job,
          slots: [{ key: "gone", limit: 1 }],
          recheckMs: { near: 60_000, far: 60_000 },
        });

      const a = await driver.enqueue({ name: "A", args: "[]" });
      const claimedA = await claimOne();
      expect(claimedA.id).toBe(a);
      expect(await ask(claimedA)).toBe(true);

      await driver.enqueue({ name: "B", args: "[]" });
      const claimedB = await claimOne();
      expect(await ask(claimedB)).toBe(false);
      // Parked a minute out: nothing to claim.
      expect(await driver.claim(1, { visibilityTimeoutMs: 60_000 })).toEqual([]);

      // A ends without handing its slot on, as a process that died between
      // the two would.
      await driver.complete(claimedA);

      // The next step on the line drops A, keeps C behind B, and wakes B.
      await driver.enqueue({ name: "C", args: "[]" });
      const claimedC = await claimOne();
      expect(claimedC.name).toBe("C");
      expect(await ask(claimedC)).toBe(false);
      const woken = await claimOne();
      expect(woken.id).toBe(claimedB.id);
      // Its attempt was taken back when it was parked.
      expect(woken.attempt).toBe(1);
      expect(await ask(woken)).toBe(true);

      // Releasing B wakes C.
      await driver.releaseSlots!(woken.id);
      const next = await claimOne();
      expect(next.id).toBe(claimedC.id);
      expect(await ask(next)).toBe(true);
    },
  );

  if (backend.name !== "memory" && backend.name !== "sqlite") {
    test("two processes share one line", { timeout: 30_000 }, async () => {
      const store = await open();
      let running = 0;
      let most = 0;
      let done = 0;
      class Shared extends Job {
        static name = "Shared";
        concurrency() {
          return { key: "shared", limit: 2 };
        }
        async run() {
          running++;
          most = Math.max(most, running);
          await sleep(40);
          running--;
          done++;
        }
      }
      const [a, b] = workers(store, [Shared]);
      for (let n = 0; n < 5; n++) {
        await a!.push(Shared, "[]");
        await b!.push(Shared, "[]");
      }
      await until(() => done === 10, 20_000);
      expect(most).toBe(2);
    });
  }

  describe("workflows", () => {
    test(
      "one slot is held for the whole workflow, first come first served",
      { timeout: 30_000 },
      async () => {
        const store = await open();
        const spans: Array<{ n: number; begin: number; end: number }> = [];
        class Import extends Workflow {
          static name = "ImportWorkflow";
          async concurrency() {
            return { key: "imports", limit: 1 };
          }
          async run(step: Step, n: number) {
            const begin = await step.run("begin", () => Date.now());
            await step.sleep("settle", 60);
            const end = await step.run("end", () => Date.now());
            spans.push({ n, begin, end });
          }
        }
        const [queue] = workers(store, [], { workflows: [Import] });
        const ids: string[] = [];
        for (let n = 0; n < 3; n++) {
          ids.push(await queue!.workflows.start(Import, [n]));
          await sleep(30);
        }
        await until(async () => {
          const statuses = await Promise.all(ids.map((id) => queue!.workflows.find(id)));
          return statuses.every((status) => status?.status === "completed");
        }, 20_000);
        spans.sort((x, y) => x.begin - y.begin);
        expect(spans.map((span) => span.n)).toEqual([0, 1, 2]);
        // The sleep between the steps did not hand the slot on.
        for (let i = 1; i < spans.length; i++) {
          expect(spans[i]!.begin).toBeGreaterThanOrEqual(spans[i - 1]!.end);
        }
      },
    );

    test(
      "pausing gives the slot up, and a waiting workflow can be cancelled",
      { timeout: 30_000 },
      async () => {
        const store = await open();
        const began: string[] = [];
        const cancelled: string[] = [];
        class Gate extends Workflow {
          static name = "GateWorkflow";
          concurrency() {
            return { key: "gate", limit: 1 };
          }
          async run(step: Step, name: string) {
            await step.run("begin", () => {
              began.push(name);
            });
            await step.waitFor("go", { timeout: "1h" });
          }
          async onCancel(step: Step, name: string) {
            await step.run("undo", () => {
              cancelled.push(name);
            });
          }
        }
        const [queue] = workers(store, [], { workflows: [Gate] });
        const status = async (id: string) => (await queue!.workflows.find(id))?.status;
        const first = await queue!.workflows.start(Gate, ["first"]);
        await until(() => began.includes("first"));
        const second = await queue!.workflows.start(Gate, ["second"]);
        await sleep(30);
        const third = await queue!.workflows.start(Gate, ["third"]);
        await sleep(200);
        expect(began).toEqual(["first"]);

        // The waiting third one is cancelled: `onCancel` runs without a slot.
        expect(await queue!.workflows.cancel(third)).toBe(true);
        await until(async () => (await status(third)) === "cancelled");
        expect(cancelled).toEqual(["third"]);
        expect(began).toEqual(["first"]);

        // Pausing the first hands its slot to the second.
        expect(await queue!.workflows.pause(first)).toBe(true);
        await until(() => began.includes("second"));

        // Resumed, the first waits behind the second until that one ends.
        expect(await queue!.workflows.resume(first)).toBe(true);
        await sleep(200);
        expect(await status(first)).not.toBe("completed");
        await queue!.workflows.signal(second, "go");
        await until(async () => (await status(second)) === "completed");
        await queue!.workflows.signal(first, "go");
        await until(async () => (await status(first)) === "completed");
      },
    );
  });
});
