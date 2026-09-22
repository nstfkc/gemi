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

  test("a job outrunning the deadline is reported, and the provider timed out", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Gated } = gated();
    const application = await makeApp({ jobs: [Gated] });
    await application.make(QueueManager).push(Gated, "[1]");
    await sleep(0);

    const report = await application.shutdown({ timeoutMs: 50 });

    expect(report.timedOut).toEqual(["QueueServiceProvider"]);
    expect(error.mock.calls.flat().join(" ")).toContain("QueueServiceProvider.shutdown()");
  });

  test("does not build a queue nothing used", async () => {
    const application = await makeApp({});
    expect(application.resolved(QueueManager)).toBe(false);

    await application.shutdown({ timeoutMs: 1_000 });

    expect(application.resolved(QueueManager)).toBe(false);
  });
});

test("once the server is shutting down, a dispatch is recorded and not claimed", async () => {
  const { Gated, started } = gated();
  const queue = new QueueManager({ jobs: [Gated] });

  markShuttingDown();
  await queue.push(Gated, "[1]");
  await sleep(10);

  expect(started).toEqual([]);
  expect((queue.driver as MemoryQueueDriver).waiting).toBe(1);
  await queue.stop();
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
