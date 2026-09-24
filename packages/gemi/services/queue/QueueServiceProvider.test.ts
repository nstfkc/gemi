import { afterEach, describe, expect, test, vi } from "vitest";

import { DatabaseManager } from "../../database/DatabaseManager";
import { DatabaseServiceProvider } from "../../database/DatabaseServiceProvider";
import { Application } from "../../foundation/Application";
import { markShuttingDown, resetShuttingDown } from "../../server/shutdown";
import { Repository } from "../../support/Repository";
import { DatabaseQueueDriver } from "./DatabaseQueueDriver";
import { Job } from "./Job";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import type { QueueConfig } from "./config";
import { QueueManager } from "./QueueManager";
import { QueueServiceProvider, startClaimingIfServing } from "./QueueServiceProvider";

/**
 * The queue's part in a process's life: draining in the provider shutdown
 * (#48), claiming nothing new once the server has been told to stop, and —
 * with a driver that outlives the process — claiming at boot what a previous
 * process left behind.
 */

const env = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  resetShuttingDown();
  globalThis.__gemiDevQueue = undefined;
  process.env.NODE_ENV = env.NODE_ENV;
  process.env.ROOT_DIR = env.ROOT_DIR;
  if (env.ROOT_DIR === undefined) delete process.env.ROOT_DIR;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeApp(queue: QueueConfig, database?: { url: string }) {
  const application = new Application(
    new Repository({ queue: { jobs: [], ...queue }, database: database ?? {} }),
  );
  application.registerMany(
    database ? [DatabaseServiceProvider, QueueServiceProvider] : [QueueServiceProvider],
  );
  await application.boot();
  return application;
}

function gated() {
  const started: number[] = [];
  const gates: Array<() => void> = [];
  class Gated extends Job {
    static name = "Gated";
    run(n: number) {
      started.push(n);
      return new Promise<void>((resolve) => gates.push(resolve));
    }
  }
  return { Gated, started, release: () => gates.shift()!() };
}

describe("the provider's shutdown", () => {
  test("waits for the jobs running, and claims nothing more", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { Gated, started, release } = gated();
    const application = await makeApp({ jobs: [Gated], concurrency: 1 });
    const queue = application.make(QueueManager);

    await queue.push(Gated, "[1]");
    await queue.push(Gated, "[2]");
    await sleep(0);
    expect(started).toEqual([1]);

    let finished = false;
    const shutdown = application.shutdown({ timeoutMs: 2_000 }).then((report) => {
      finished = true;
      return report;
    });
    await sleep(20);
    expect(finished).toBe(false);

    release();
    expect(await shutdown).toEqual({ failed: [], timedOut: [] });
    // The slot the first job freed was not refilled: the second is still
    // waiting in the driver for whichever process claims next.
    expect(started).toEqual([1]);
    expect((queue.driver as MemoryQueueDriver).waiting).toBe(1);
  });

  test("a job outrunning the deadline is named by the queue, not just timed out", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Gated } = gated();
    const application = await makeApp({ jobs: [Gated] });
    await application.make(QueueManager).push(Gated, "[1]");
    await sleep(0);

    const report = await application.shutdown({ timeoutMs: 50 });

    // The point of the log is telling the operator *which* job was abandoned.
    // Draining without a bound could never do that: `drain()` would resolve
    // only once every job had finished, so nothing was ever unfinished, and
    // all the operator got was `Application`'s generic "did not finish within
    // the provider shutdown deadline", which names nothing. The provider now
    // bounds its own drain inside the deadline and reports.
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("Queued jobs still running at shutdown");
    expect(logged).toContain("Gated");
    expect(report.timedOut).toEqual([]);
  });

  test("does not build a queue nothing used", async () => {
    const application = await makeApp({});
    expect(application.resolved(QueueManager)).toBe(false);

    await application.shutdown({ timeoutMs: 1_000 });

    expect(application.resolved(QueueManager)).toBe(false);
  });
});

describe("once the server is shutting down", () => {
  test("a durable driver's dispatch is recorded and not claimed, for another replica to run", async () => {
    const { Gated, started } = gated();
    const kept = new MemoryQueueDriver();
    const queue = new QueueManager({ jobs: [Gated], driver: bind(kept) });

    markShuttingDown();
    await queue.push(Gated, "[1]");
    await sleep(10);

    expect(started).toEqual([]);
    expect(kept.waiting).toBe(1);
    await queue.stop();
  });

  test("the memory driver keeps claiming until the provider drains it, and the drain waits for what it claimed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { Gated, started, release } = gated();
    const application = await makeApp({ jobs: [Gated], concurrency: 1 });
    const queue = application.make(QueueManager);
    await queue.push(Gated, "[1]");
    await queue.push(Gated, "[2]");
    await sleep(0);

    // The signal: requests still draining can dispatch, and nobody but this
    // process can run a memory job.
    markShuttingDown();
    await queue.push(Gated, "[3]");
    release();
    await sleep(10);
    expect(started).toEqual([1, 2]);

    let finished = false;
    const shutdown = application.shutdown({ timeoutMs: 2_000 }).then((report) => {
      finished = true;
      return report;
    });
    await sleep(20);
    expect(finished).toBe(false);

    release();
    expect(await shutdown).toEqual({ failed: [], timedOut: [] });
    // Draining stopped the loop, so the dispatch that was still waiting when
    // the provider shut down is lost with the process — the memory driver's
    // documented limit, not a new one.
    expect(started).toEqual([1, 2]);
  });
});

describe("a dispatch with a durable driver", () => {
  test("from a process that is not a server records the job and claims nothing", async () => {
    delete process.env.ROOT_DIR;
    const { Gated, started } = gated();
    const kept = new MemoryQueueDriver();
    await kept.enqueue({ name: "Gated", args: "[0]" });
    const application = await makeApp({ jobs: [Gated], driver: () => bind(kept) });
    const queue = application.make(QueueManager);

    await queue.push(Gated, "[1]");
    await sleep(10);

    expect(started).toEqual([]);
    expect(kept.waiting).toBe(2);
    await queue.stop();
  });

  test("from a server, development included, starts claiming", async () => {
    process.env.ROOT_DIR = "/srv/app";
    const { Gated, started, release } = gated();
    const kept = new MemoryQueueDriver();
    const application = await makeApp({ jobs: [Gated], driver: () => bind(kept) });
    const queue = application.make(QueueManager);

    await queue.push(Gated, "[1]");
    await sleep(10);

    expect(started).toEqual([1]);
    release();
    await queue.stop();
  });
});

describe("claiming at boot", () => {
  function serving() {
    process.env.NODE_ENV = "production";
    process.env.ROOT_DIR = "/srv/app";
  }

  test("a production server with a durable driver claims what is waiting, with no dispatch", async () => {
    serving();
    const { Gated, started, release } = gated();
    // A durable driver as far as the provider can tell: not the memory one.
    const kept = new MemoryQueueDriver();
    const durable = bind(kept);
    await kept.enqueue({ name: "Gated", args: "[7]" });
    const application = await makeApp({ jobs: [Gated], driver: () => durable });

    startClaimingIfServing(application);
    await sleep(10);

    expect(started).toEqual([7]);
    release();
    await application.make(QueueManager).stop();
  });

  test.each([
    ["the memory driver", () => serving(), {}],
    [
      "a console command",
      () => {
        serving();
        delete process.env.ROOT_DIR;
      },
      { durable: true },
    ],
    ["development", () => (process.env.ROOT_DIR = "/srv/app"), { durable: true }],
  ])("not with %s", async (_, setup, { durable }: { durable?: boolean }) => {
    setup();
    const application = await makeApp(
      durable ? { driver: () => bind(new MemoryQueueDriver()) } : {},
    );

    startClaimingIfServing(application);

    expect(application.resolved(QueueManager)).toBe(false);
  });
});

describe("a gemi dev reload", () => {
  /**
   * One application as `bun --hot` boots it after a save: its own job class,
   * standing for the code as it was then, over the storage every reload
   * shares — the table, which `kept` plays here.
   */
  async function generation(kept: MemoryQueueDriver, code: string, ran: string[]) {
    class Report extends Job {
      static name = "Report";
      run() {
        ran.push(code);
      }
    }
    const application = await makeApp({ jobs: [Report], driver: () => bind(kept) });
    return { application, Report, queue: () => application.make(QueueManager) };
  }

  function developing() {
    process.env.NODE_ENV = "development";
    process.env.ROOT_DIR = "/srv/app";
  }

  test("stops the loop the previous application started, and runs later jobs on the new code", async () => {
    developing();
    const kept = new MemoryQueueDriver();
    const ran: string[] = [];
    const before = await generation(kept, "before the save", ran);
    await before.queue().push(before.Report, "[]");
    await vi.waitFor(() => expect(ran).toEqual(["before the save"]));

    const after = await generation(kept, "after the save", ran);
    startClaimingIfServing(after.application);

    // A row another process wrote, or a retry coming due: nobody here
    // dispatched it, so only a loop already running can claim it.
    await kept.enqueue({ name: "Report", args: "[]" });
    await vi.waitFor(() => expect(ran).toHaveLength(2));
    await sleep(20);

    expect(ran).toEqual(["before the save", "after the save"]);
    expect(globalThis.__gemiDevQueue).toBe(after.queue());
    await after.queue().stop();
  });

  test("starts nothing when no loop was running, as development never claims at boot", async () => {
    developing();
    const kept = new MemoryQueueDriver();
    const { application } = await generation(kept, "after the save", []);

    startClaimingIfServing(application);

    expect(application.resolved(QueueManager)).toBe(false);
  });

  test("a loop stopped before the save is not started again by the reload", async () => {
    developing();
    const ran: string[] = [];
    const kept = new MemoryQueueDriver();
    const before = await generation(kept, "before the save", ran);
    await before.queue().push(before.Report, "[]");
    await vi.waitFor(() => expect(ran).toHaveLength(1));
    await before.queue().stop();

    const after = await generation(kept, "after the save", ran);
    startClaimingIfServing(after.application);

    expect(after.application.resolved(QueueManager)).toBe(false);
    expect(globalThis.__gemiDevQueue).toBeUndefined();
  });

  test("a second boot of one application leaves its own loop running", async () => {
    developing();
    const ran: string[] = [];
    const kept = new MemoryQueueDriver();
    const only = await generation(kept, "only", ran);
    await only.queue().push(only.Report, "[]");

    startClaimingIfServing(only.application);
    await kept.enqueue({ name: "Report", args: "[]" });

    await vi.waitFor(() => expect(ran).toEqual(["only", "only"]));
    await only.queue().stop();
  });

  test("an application without the queue provider stops the stale loop and resolves nothing", async () => {
    developing();
    const ran: string[] = [];
    const kept = new MemoryQueueDriver();
    const before = await generation(kept, "before the save", ran);
    await before.queue().push(before.Report, "[]");
    await vi.waitFor(() => expect(ran).toHaveLength(1));

    const bare = new Application(new Repository({}));
    await bare.boot();
    expect(() => startClaimingIfServing(bare)).not.toThrow();

    await kept.enqueue({ name: "Report", args: "[]" });
    await sleep(20);
    expect(ran).toHaveLength(1);
    expect(globalThis.__gemiDevQueue).toBeUndefined();
  });

  test("a memory queue is left running, because nothing else can run what it holds", async () => {
    developing();
    const ran: string[] = [];
    class Report extends Job {
      static name = "Report";
      run() {
        ran.push("before the save");
      }
    }
    const before = await makeApp({ jobs: [Report] });
    const queue = before.make(QueueManager);
    await queue.push(Report, "[]");

    startClaimingIfServing(await makeApp({ jobs: [] }));
    await queue.push(Report, "[]");

    await vi.waitFor(() => expect(ran).toHaveLength(2));
    await queue.stop();
  });
});

describe('driver: "database"', () => {
  test("keeps jobs in the default connection's gemi_jobs table", async () => {
    const application = await makeApp({ driver: "database" }, { url: ":memory:" });
    const driver = application.make(QueueManager).driver;

    expect(driver).toBeInstanceOf(DatabaseQueueDriver);
    expect((driver as DatabaseQueueDriver).table).toBe("gemi_jobs");
    await (driver as DatabaseQueueDriver).createTable();
    const database = application.make(DatabaseManager);
    await driver.enqueue({ name: "A", args: "[]" });
    expect([...(await database.sql`SELECT name FROM gemi_jobs`)]).toEqual([{ name: "A" }]);
    await database.close();
  });

  test("a factory is handed the application, to choose a connection", async () => {
    let seen: Application | undefined;
    const application = await makeApp({
      driver: (app) => {
        seen = app;
        return new MemoryQueueDriver();
      },
    });
    application.make(QueueManager);
    expect(seen).toBe(application);
  });

  test("a manager built without an application refuses it at construction", () => {
    expect(() => new QueueManager({ driver: "database" })).toThrow(
      "needs the application it belongs to",
    );
  });
});

/** The memory driver's methods, on an object that is not a `MemoryQueueDriver`. */
function bind(driver: MemoryQueueDriver) {
  return {
    enqueue: driver.enqueue.bind(driver),
    claim: driver.claim.bind(driver),
    complete: driver.complete.bind(driver),
    fail: driver.fail.bind(driver),
    heartbeat: driver.heartbeat.bind(driver),
    subscribe: driver.subscribe.bind(driver),
  };
}
