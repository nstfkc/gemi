import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Dialect } from "../../database/dialect";
import { DatabaseQueueDriver, createTableStatements } from "./DatabaseQueueDriver";
import { Job } from "./Job";
import type { QueueDriver } from "./QueueDriver";
import { QueueManager } from "./QueueManager";
import { queueDriverContract } from "./queueDriverContract";

/**
 * The database driver, against SQLite always and against Postgres and MySQL
 * when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` name a database it may create
 * and drop tables in. Each test gets a table of its own there, so parallel
 * files cannot truncate each other's rows.
 *
 * "Two processes" is two `SQL` clients on one database: two pools against
 * Postgres or MySQL, two connections to one file for SQLite. Each worker is a
 * `QueueManager` over its own client, which is everything a second replica
 * would bring except the second address space.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

type Backend = {
  name: string;
  dialect: Dialect;
  /** A fresh, empty database for one test: `connect` opens clients to it. */
  prepare(): Promise<{ connect(): SQL; table: string; dispose(): Promise<void> }>;
};

const sqlite: Backend = {
  name: "sqlite",
  dialect: "sqlite",
  async prepare() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-queue-"));
    const url = `sqlite://${join(dir, "jobs.db")}`;
    const clients: SQL[] = [];
    const table = "gemi_jobs";
    const first = new SQL(url);
    clients.push(first);
    await new DatabaseQueueDriver({ sql: first, dialect: "sqlite" }, { table }).createTable();
    return {
      table,
      connect() {
        const client = new SQL(url);
        clients.push(client);
        return client;
      },
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
      const table = `gemi_jobs_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const clients: SQL[] = [];
      const first = new SQL(url);
      clients.push(first);
      await new DatabaseQueueDriver({ sql: first, dialect }, { table }).createTable();
      return {
        table,
        connect() {
          const client = new SQL(url);
          clients.push(client);
          return client;
        },
        async dispose() {
          await first.unsafe(`DROP TABLE IF EXISTS ${table}`);
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

// The contract, once per backend. The driver's database is disposed with it.
const disposers = new WeakMap<QueueDriver, () => Promise<void>>();
for (const backend of backends) {
  queueDriverContract(
    `DatabaseQueueDriver on ${backend.name}`,
    async () => {
      const db = await backend.prepare();
      const driver = new DatabaseQueueDriver(
        { sql: db.connect(), dialect: backend.dialect },
        { table: db.table },
      );
      disposers.set(driver, db.dispose);
      return driver;
    },
    (driver) => disposers.get(driver)?.(),
  );
}

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DatabaseQueueDriver on the servers this run has no URL for", () => {
    test.skip(
      `postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
        `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}`,
      () => {},
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await sleep(10);
  }
}

/** A job class registered under `name`, recording each run as `worker`. */
function recorder(name: string, worker: string, runs: Array<{ n: number; worker: string }>) {
  return {
    [worker]: class extends Job {
      static name = name;
      async run(n: number) {
        runs.push({ n, worker });
        // Long enough that the other worker is claiming while this one runs.
        await sleep(5);
      }
    },
  }[worker]!;
}

describe.each(backends)("DatabaseQueueDriver on $name", (backend) => {
  let dispose: (() => Promise<void>) | undefined;
  const managers: QueueManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.stop()));
    await dispose?.();
    dispose = undefined;
  });

  async function database() {
    const db = await backend.prepare();
    dispose = db.dispose;
    const driver = () =>
      new DatabaseQueueDriver({ sql: db.connect(), dialect: backend.dialect }, { table: db.table });
    const reader = db.connect();
    const rows = async () =>
      (await reader.unsafe(`SELECT * FROM ${db.table} ORDER BY created_at, id`)) as Array<
        Record<string, unknown>
      >;
    return { driver, rows };
  }

  function worker(driver: QueueDriver, jobs: Array<new () => Job>, config = {}) {
    const manager = new QueueManager({
      driver,
      jobs,
      concurrency: 4,
      pollInterval: 20,
      ...config,
    });
    managers.push(manager);
    return manager;
  }

  test("two workers on one database never run one job twice", async () => {
    const { driver, rows } = await database();
    const runs: Array<{ n: number; worker: string }> = [];
    const a = worker(driver(), [recorder("RecordRun", "a", runs)]);
    const b = worker(driver(), [recorder("RecordRun", "b", runs)]);

    const producer = driver();
    for (let n = 0; n < 40; n++) {
      await producer.enqueue({ name: "RecordRun", args: JSON.stringify([n]) });
    }
    a.start();
    b.start();

    await until(async () => runs.length >= 40 && (await rows()).length === 0);
    // A double claim would show up as a 41st run just after the 40th.
    await sleep(100);

    expect(runs.map((run) => run.n).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 40 }, (_, n) => n),
    );
    // Both really claimed, or this proved nothing about concurrent claims.
    expect(new Set(runs.map((run) => run.worker))).toEqual(new Set(["a", "b"]));
  });

  test("a job whose worker died is run by another once its lease runs out", async () => {
    const { driver, rows } = await database();
    const lease = 400;
    await driver().enqueue({ name: "RecordRun", args: "[1]" });

    // The worker that dies: it claims, and never reports or heartbeats again.
    const [lost] = await driver().claim(1, { visibilityTimeoutMs: lease });
    const claimedAt = Date.now();
    expect(lost).toMatchObject({ attempt: 1 });

    const runs: Array<{ n: number; worker: string }> = [];
    const survivor = worker(driver(), [recorder("RecordRun", "survivor", runs)]);
    survivor.start();

    await sleep(lease / 2);
    expect(runs).toEqual([]);

    await until(() => runs.length === 1);
    expect(Date.now() - claimedAt).toBeGreaterThanOrEqual(lease - 50);
    await until(async () => (await rows()).length === 0);
    expect(runs).toEqual([{ n: 1, worker: "survivor" }]);
  });

  test("a job whose last attempt died with its worker is dead-lettered, and the row says why", async () => {
    const { driver, rows } = await database();
    const run = vi.fn();
    const deadletter = vi.fn();
    class OneShot extends Job {
      static name = "OneShot";
      maxAttempts = 1;
      run() {
        run();
      }
      onDeadletter(error: Error) {
        deadletter(error);
      }
    }
    await driver().enqueue({ name: "OneShot", args: "[]" });
    await driver().claim(1, { visibilityTimeoutMs: 100 });

    worker(driver(), [OneShot]).start();
    await until(() => deadletter.mock.calls.length === 1);

    expect(run).not.toHaveBeenCalled();
    await until(async () => (await rows())[0]?.status === "dead");
    const [row] = await rows();
    expect(Number(row!.attempts)).toBe(2);
    expect(String(row!.last_error)).toContain("never finished");
  });

  test("retries are persisted with their attempt and error, and a dead letter is kept until pruned", async () => {
    const { driver, rows } = await database();
    class AlwaysThrows extends Job {
      static name = "AlwaysThrows";
      maxAttempts = 3;
      backoff = [50, 50];
      run(): void {
        throw new Error("smtp is down");
      }
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = worker(driver(), [AlwaysThrows]);
    await queue.push(AlwaysThrows, "[]");

    await until(async () => Number((await rows())[0]?.attempts) === 1);
    await until(async () => (await rows())[0]?.status === "pending");
    const [retrying] = await rows();
    expect(String(retrying!.last_error)).toContain("smtp is down");
    expect(Number(retrying!.available_at)).toBeGreaterThan(Number(retrying!.updated_at));

    await until(async () => (await rows())[0]?.status === "dead");
    const [dead] = await rows();
    expect(Number(dead!.attempts)).toBe(3);
    expect(String(dead!.last_error)).toContain("smtp is down");

    const pruner = driver();
    expect(await pruner.prune(60_000)).toBe(0);
    expect(await pruner.prune(0)).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  test("jobs left in the table are run by a worker that starts later, without a dispatch", async () => {
    const { driver, rows } = await database();
    const before = driver();
    await before.enqueue({ name: "RecordRun", args: "[1]" });
    await before.enqueue({ name: "RecordRun", args: "[2]", delayMs: 100 });

    const runs: Array<{ n: number; worker: string }> = [];
    worker(driver(), [recorder("RecordRun", "next", runs)]).start();

    await until(() => runs.length === 2);
    expect(runs.map((run) => run.n)).toEqual([1, 2]);
    await until(async () => (await rows()).length === 0);
  });

  test("a dispatch is claimed without waiting out the poll interval", async () => {
    const { driver } = await database();
    const runs: Array<{ n: number; worker: string }> = [];
    const Recorder = recorder("RecordRun", "here", runs);
    const queue = worker(driver(), [Recorder], { pollInterval: 60_000 });
    queue.start();
    // Let the first, empty claim finish, so the loop is asleep on the poll.
    await sleep(50);

    await queue.push(Recorder, "[5]");
    await until(() => runs.length === 1, 1_000);
  });
});

describe("DatabaseQueueDriver", () => {
  test("refuses a table name it would have to quote", () => {
    const sql = new SQL(":memory:");
    expect(
      () => new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { table: "jobs; drop table x" }),
    ).toThrow("not a plain identifier");
  });

  test("createTable is idempotent", async () => {
    const sql = new SQL(":memory:");
    const driver = new DatabaseQueueDriver({ sql, dialect: "sqlite" });
    await driver.createTable();
    await driver.createTable();
    expect(await driver.claim(1, { visibilityTimeoutMs: 1000 })).toEqual([]);
    await sql.close();
  });

  test("the MySQL table keeps its indexes inside CREATE TABLE, which has IF NOT EXISTS", () => {
    const [statement, ...rest] = createTableStatements("mysql", "gemi_jobs");
    expect(rest).toEqual([]);
    expect(statement).toContain("CREATE TABLE IF NOT EXISTS `gemi_jobs`");
    expect(statement).toContain("INDEX `gemi_jobs_status_available_at_idx`");
  });
});
