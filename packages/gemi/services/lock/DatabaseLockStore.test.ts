import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import { CronJob } from "../cron/CronJob";
import { runTick } from "../cron/Scheduler";
import { DatabaseQueueDriver } from "../queue/DatabaseQueueDriver";
import { Job } from "../queue/Job";
import { QueueManager } from "../queue/QueueManager";
import { DatabaseLockStore } from "./DatabaseLockStore";
import { type HeldLock, LockManager } from "./LockManager";
import { lockStoreContract } from "./lockStoreContract";

/**
 * The database lock store and what is built on it, against SQLite always and
 * Postgres and MySQL when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set (CI's
 * `queue-databases` job sets both). "Instances" are separate `SQL` clients on
 * one database, as in the queue driver's tests: everything a second replica
 * brings except the second address space.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

type Database = {
  connect(): SQL;
  dialect: Dialect;
  locks: string;
  jobs: string;
  dispose(): Promise<void>;
};

type Backend = { name: string; open(): Promise<Database> };

function quote(dialect: Dialect, table: string) {
  return dialect === "mysql" || dialect === "mariadb" ? `\`${table}\`` : `"${table}"`;
}

async function prepare(
  dialect: Dialect,
  url: string,
  locks: string,
  jobs: string,
  cleanup: (first: SQL) => Promise<void>,
): Promise<Database> {
  const clients: SQL[] = [];
  const first = new SQL(url);
  clients.push(first);
  await new DatabaseLockStore({ sql: first, dialect }, { table: locks }).createTable();
  await new DatabaseQueueDriver({ sql: first, dialect }, { table: jobs }).createTable();
  return {
    dialect,
    locks,
    jobs,
    connect() {
      // A small pool per client: the tests open many "instances", and
      // Postgres refuses past 100 connections.
      const client = dialect === "sqlite" ? new SQL(url) : new SQL(url, { max: 2 });
      clients.push(client);
      return client;
    },
    async dispose() {
      await cleanup(first);
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

const sqlite: Backend = {
  name: "sqlite",
  async open() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-locks-"));
    return prepare(
      "sqlite",
      `sqlite://${join(dir, "locks.db")}`,
      "gemi_locks",
      "gemi_jobs",
      async () => rmSync(dir, { recursive: true, force: true }),
    );
  },
};

function server(name: string, dialect: Dialect, url: string): Backend {
  return {
    name,
    async open() {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const locks = `GemiLocks_${suffix}`;
      const jobs = `GemiJobs_${suffix}`;
      return prepare(dialect, url, locks, jobs, async (first) => {
        await first.unsafe(`DROP TABLE IF EXISTS ${quote(dialect, locks)}`);
        await first.unsafe(`DROP TABLE IF EXISTS ${quote(dialect, jobs)}`);
      });
    },
  };
}

const backends: Backend[] = [
  sqlite,
  ...(POSTGRES_URL ? [server("postgres", "postgres", POSTGRES_URL)] : []),
  ...(MYSQL_URL ? [server("mysql", "mysql", MYSQL_URL)] : []),
];

for (const backend of backends) {
  lockStoreContract(`DatabaseLockStore on ${backend.name}`, async () => {
    const db = await backend.open();
    return {
      store: () =>
        new DatabaseLockStore({ sql: db.connect(), dialect: db.dialect }, { table: db.locks }),
      dispose: db.dispose,
    };
  });
}

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DatabaseLockStore on the servers this run has no URL for", () => {
    test.skip(
      `postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
        `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}`,
      () => {},
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await sleep(10);
  }
}

describe.each(backends)("locks across instances on $name", (backend) => {
  let db: Database | undefined;
  const managers: QueueManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.drain(5_000)));
    await db?.dispose();
    db = undefined;
  });

  async function open() {
    db = await backend.open();
    return db;
  }

  /** One instance: a queue manager over its own client, with its locks in the same database. */
  function instance(database: Database, jobs: Array<new () => Job>) {
    const driver = new DatabaseQueueDriver(
      { sql: database.connect(), dialect: database.dialect },
      { table: database.jobs },
    );
    const locks = new DatabaseLockStore(
      { sql: database.connect(), dialect: database.dialect },
      { table: database.locks },
    );
    const manager = new QueueManager({ driver, jobs, locks, concurrency: 4, pollInterval: 20 });
    managers.push(manager);
    return manager;
  }

  async function countJobs(database: Database) {
    const reader = database.connect();
    const rows = (await reader.unsafe(
      `SELECT COUNT(*) AS n FROM ${quote(database.dialect, database.jobs)}`,
    )) as Array<{ n: unknown }>;
    return Number(rows[0]!.n);
  }

  test("a unique job dispatched from several instances at once is queued once", async () => {
    const database = await open();
    const runs: string[] = [];
    class Rebuild extends Job {
      static name = "Rebuild";
      uniqueId(reportId: string) {
        return reportId;
      }
      async run(reportId: string) {
        runs.push(reportId);
      }
    }
    const instances = Array.from({ length: 4 }, () => instance(database, [Rebuild]));
    instances.forEach((manager) => manager.stop());

    const ids = await Promise.all(
      instances.flatMap((manager) => [
        manager.push(Rebuild, JSON.stringify(["r1"])),
        manager.push(Rebuild, JSON.stringify(["r1"])),
      ]),
    );
    // Coalesced: every dispatch resolves to the one job's id.
    expect(new Set(ids).size).toBe(1);
    expect(await countJobs(database)).toBe(1);

    // A different key is its own job.
    await instances[0]!.push(Rebuild, JSON.stringify(["r2"]));
    expect(await countJobs(database)).toBe(2);
  });

  test("the key is freed when the job completes, so the next dispatch queues again", async () => {
    const database = await open();
    const runs: string[] = [];
    class Refresh extends Job {
      static name = "Refresh";
      uniqueId() {
        return "usage";
      }
      async run(tag: string) {
        runs.push(tag);
      }
    }
    const a = instance(database, [Refresh]);
    const b = instance(database, [Refresh]);
    a.start();

    await a.push(Refresh, JSON.stringify(["first"]));
    await until(async () => runs.length === 1 && (await countJobs(database)) === 0);
    await until(async () => (await a.locks.store.holder("gemi:job:Refresh:usage")) === null);

    await b.push(Refresh, JSON.stringify(["second"]));
    await until(() => runs.length === 2);
    expect(runs).toEqual(["first", "second"]);
  });

  test("a unique key whose job vanished frees itself after uniqueFor", async () => {
    const database = await open();
    class Short extends Job {
      static name = "Short";
      uniqueFor = 200;
      uniqueId() {
        return "k";
      }
    }
    const a = instance(database, [Short]);
    a.stop();
    const first = await a.push(Short, "[]");
    expect(await a.push(Short, "[]")).toBe(first);
    await sleep(350);
    const second = await instance(database, [Short]).push(Short, "[]");
    expect(second).not.toBe(first);
  });

  test("withoutOverlapping: concurrent ticks on several instances run the callback once", async () => {
    const database = await open();
    let running = 0;
    let most = 0;
    let runs = 0;
    class Report extends CronJob {
      name = "report";
      cron = "* * * * *";
      withoutOverlapping = { expiresAfter: 2_000 };
      async callback() {
        runs++;
        running++;
        most = Math.max(most, running);
        await sleep(200);
        running--;
      }
    }
    const instances = Array.from({ length: 3 }, () => {
      const store = new DatabaseLockStore(
        { sql: database.connect(), dialect: database.dialect },
        { table: database.locks },
      );
      const locks = new LockManager(store);
      return () => locks;
    });
    await Promise.all(instances.map((locks) => runTick(new Report(), { locks })));
    expect(runs).toBe(1);
    expect(most).toBe(1);

    // Once it finished, the next tick runs again.
    await runTick(new Report(), { locks: instances[1] });
    expect(runs).toBe(2);
  });

  test("withoutOverlapping: a tick that outlives its lease is told, and a new tick can start", async () => {
    const database = await open();
    const store = () =>
      new DatabaseLockStore(
        { sql: database.connect(), dialect: database.dialect },
        { table: database.locks },
      );
    let lostSeen = false;
    let started = 0;
    class Stalled extends CronJob {
      name = "stalled";
      cron = "* * * * *";
      withoutOverlapping = { expiresAfter: 200 };
      async callback(lock?: HeldLock) {
        started++;
        if (started > 1) return;
        await sleep(400);
        lostSeen = lock!.lost.aborted;
      }
    }
    // An instance that cannot reach the database to renew its lease.
    const unreachable = store();
    unreachable.extend = () => new Promise<boolean>(() => {});
    const a = new LockManager(unreachable);
    const b = new LockManager(store());
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args[0]);
    try {
      const stalled = runTick(new Stalled(), { locks: () => a });
      await sleep(300);
      await runTick(new Stalled(), { locks: () => b });
      await stalled;
    } finally {
      console.error = original;
    }
    expect(started).toBe(2);
    expect(lostSeen).toBe(true);
    expect(errors.some((line) => String(line).includes("lost its withoutOverlapping lock"))).toBe(
      true,
    );
  });

  test("onOneServer: each tick runs on one instance only", async () => {
    const database = await open();
    let runs = 0;
    class Daily extends CronJob {
      name = "daily";
      cron = "0 9 * * *";
      onOneServer = true;
      async callback() {
        runs++;
      }
    }
    const instances = Array.from({ length: 4 }, () => {
      const locks = new LockManager(
        new DatabaseLockStore(
          { sql: database.connect(), dialect: database.dialect },
          { table: database.locks },
        ),
      );
      return () => locks;
    });
    const nine = Date.UTC(2026, 9, 3, 9, 0, 0);
    // The instances fire a few seconds apart, as skewed clocks would.
    await Promise.all(
      instances.map((locks, i) => runTick(new Daily(), { locks, now: nine + i * 2_000 })),
    );
    expect(runs).toBe(1);
    // The next day's tick runs again.
    await Promise.all(
      instances.map((locks) => runTick(new Daily(), { locks, now: nine + 86_400_000 })),
    );
    expect(runs).toBe(2);
  });

  test("concurrency: a per-key cap holds across instances (#661)", async () => {
    const database = await open();
    let running = 0;
    let most = 0;
    let done = 0;
    class Sync extends Job {
      static name = "Sync";
      concurrency(account: string) {
        return { key: `sync:${account}`, limit: 2 };
      }
      async run() {
        running++;
        most = Math.max(most, running);
        await sleep(80);
        running--;
        done++;
      }
    }
    const a = instance(database, [Sync]);
    const b = instance(database, [Sync]);
    for (let i = 0; i < 8; i++) await a.push(Sync, '["acme"]');
    a.start();
    b.start();
    await until(() => done === 8, 15_000);
    expect(most).toBe(2);
  });

  test("throttle: a shared budget holds across instances, and waiting costs no attempt (#661)", async () => {
    const database = await open();
    const runs: number[] = [];
    const start = Date.now();
    class Send extends Job {
      static name = "Send";
      maxAttempts = 1;
      throttle() {
        return { key: "provider", limit: 3, window: 1_500 };
      }
      run() {
        runs.push(Date.now() - start);
      }
    }
    const a = instance(database, [Send]);
    const b = instance(database, [Send]);
    for (let i = 0; i < 5; i++) await a.push(Send, "[]");
    a.start();
    b.start();
    await until(() => runs.length === 5, 15_000);
    // Three in the first window, the rest only after it ended.
    expect(runs.filter((at) => at < 1_200)).toHaveLength(3);
    expect(await countJobs(database)).toBe(0);
  });
});
