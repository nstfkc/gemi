import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONNECTION } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { TransactionDependencyError, currentTransaction, withTransaction } from "../../orm/context";
import {
  DatabaseQueueDriver,
  createBatchTableStatements,
  createTableStatements,
} from "./DatabaseQueueDriver";
import { createWorkflowTableStatements } from "./workflow/DatabaseWorkflowStore";
import type { Step } from "./workflow/Step";
import { Workflow } from "./workflow/Workflow";
import type { BatchStatus } from "./batch";
import { Job } from "./Job";
import type { QueueDriver } from "./QueueDriver";
import { QueueManager } from "./QueueManager";
import { queueDriverContract } from "./queueDriverContract";
import { workflowContract } from "./workflow/workflowContract";

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
  prepare(): Promise<{
    connect(): SQL;
    table: string;
    /** `table`, quoted the way the driver quotes it. */
    quoted: string;
    dispose(): Promise<void>;
  }>;
};

/**
 * The table name as the driver's `name()` writes it. A test that reads the
 * table directly has to quote it the same way, or a mixed-case name is folded
 * by Postgres and the row it is asserting on is in a table it cannot find.
 */
function quoteTable(dialect: Dialect, table: string) {
  const mysql = dialect === "mysql" || dialect === "mariadb";
  return mysql ? `\`${table}\`` : `"${table}"`;
}

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
      quoted: quoteTable("sqlite", table),
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
      // Mixed case on purpose: Postgres folds an unquoted name, so a query
      // that forgot to quote would miss the table `createTable` made.
      const table = `GemiJobs_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const quoted = quoteTable(dialect, table);
      const clients: SQL[] = [];
      const first = new SQL(url);
      clients.push(first);
      await new DatabaseQueueDriver({ sql: first, dialect }, { table }).createTable();
      return {
        table,
        quoted,
        connect() {
          const client = new SQL(url);
          clients.push(client);
          return client;
        },
        async dispose() {
          await first.unsafe(`DROP TABLE IF EXISTS ${quoted}`);
          await first.unsafe(`DROP TABLE IF EXISTS ${quoteTable(dialect, `${table}_batches`)}`);
          for (const suffix of ["_workflows", "_workflow_steps"]) {
            await first.unsafe(`DROP TABLE IF EXISTS ${quoteTable(dialect, `${table}${suffix}`)}`);
          }
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
//
// Named "default", as the driver `driver: "database"` builds is, so that an
// ORM transaction opened on its client is one it recognises as its own.
const disposers = new WeakMap<QueueDriver, () => Promise<void>>();
const clients = new WeakMap<QueueDriver, SQL>();
for (const backend of backends) {
  queueDriverContract(
    `DatabaseQueueDriver on ${backend.name}`,
    async () => {
      const db = await backend.prepare();
      const sql = db.connect();
      const driver = new DatabaseQueueDriver(
        { name: DEFAULT_CONNECTION, sql, dialect: backend.dialect },
        { table: db.table },
      );
      disposers.set(driver, db.dispose);
      clients.set(driver, sql);
      return driver;
    },
    (driver) => disposers.get(driver)?.(),
    {
      claimsByName: true,
      batches: true,
      transaction: {
        run: (driver, fn) => withTransaction(clients.get(driver)!, fn),
        // See `DatabaseQueueDriver.transaction` for why SQLite never joins.
        joins: backend.dialect !== "sqlite",
      },
    },
  );
}

// Workflows (#846), end to end on each database: two drivers on one
// database are two processes.
for (const backend of backends) {
  workflowContract(`DatabaseQueueDriver on ${backend.name}`, async () => {
    const db = await backend.prepare();
    return {
      driver: () =>
        new DatabaseQueueDriver(
          { name: DEFAULT_CONNECTION, sql: db.connect(), dialect: backend.dialect },
          { table: db.table },
        ),
      dispose: db.dispose,
    };
  }, { concurrentWorkers: backend.dialect !== "sqlite" });
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
    // `drain`, not `stop`: `stop()` is `drain(0)`, which stops claiming and
    // returns without waiting for what is already in flight. The table is
    // dropped a line later, so a claim or a `complete` still on its way to
    // the server came back as `Table … doesn't exist` — an unhandled
    // rejection with no test to attach it to, which failed the run about a
    // third of the time whatever the assertions said.
    await Promise.all(managers.splice(0).map((manager) => manager.drain(5_000)));
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
      (await reader.unsafe(`SELECT * FROM ${db.quoted} ORDER BY created_at, id`)) as Array<
        Record<string, unknown>
      >;
    // A driver on the default connection, as `driver: "database"` builds it,
    // with the client an ORM transaction on that connection would open on.
    const application = () => {
      const sql = db.connect();
      const driver = new DatabaseQueueDriver(
        { name: DEFAULT_CONNECTION, sql, dialect: backend.dialect },
        { table: db.table },
      );
      return { sql, driver };
    };
    return { driver, rows, application };
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
    expect(lost).toMatchObject({ attempt: 1 });
    const [leased] = await rows();
    const expiresAt = Number(leased!.lease_expires_at);
    // The whole lease, or the check below would pass for a driver that
    // ignored it and let the survivor take the job at once.
    expect(expiresAt - Number(leased!.claimed_at)).toBe(lease);

    // Each run with the row as it stood during it: the survivor's claim,
    // read from inside the run, before its `complete` deletes the row.
    const runs: Array<{ n: number; row: Record<string, unknown> }> = [];
    class RecordRow extends Job {
      static name = "RecordRun";
      async run(n: number) {
        const [row] = await rows();
        runs.push({ n, row: row! });
      }
    }
    worker(driver(), [RecordRow]).start();

    await until(() => runs.length === 1);
    // Not before the lease ran out, on the one clock that set it and that
    // the survivor's claim was checked against. The client's clock cannot
    // tell: the lease starts when the claim's UPDATE runs, and the claim
    // returns — through its commit and, on MySQL, two more round trips — a
    // loaded runner's while later. That is what `expected 347 to be greater
    // than or equal to 350` was (#618).
    const [{ n, row }] = runs as [(typeof runs)[number]];
    expect(n).toBe(1);
    expect(Number(row.claimed_at)).toBeGreaterThanOrEqual(expiresAt);
    // Run by the survivor as the next attempt: the dead one was counted.
    expect(row).toMatchObject({ id: lost!.id, status: "claimed" });
    expect(Number(row.attempts)).toBe(2);

    // And to the end, once.
    await until(async () => (await rows()).length === 0);
    expect(runs).toHaveLength(1);
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
    // The row as the read that found it waiting saw it. A second read can
    // land after the 50 ms backoff, on the next claim, whose `updated_at` is
    // past the `available_at` it was claimed at.
    let retrying: Record<string, unknown> | undefined;
    await until(async () => {
      [retrying] = await rows();
      return retrying?.status === "pending";
    });
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

  // A blue/green ramp: both releases claim from one table, and only the new
  // one has `NewReleaseJob`. `maxAttempts = 1` is what makes the tests bite —
  // an old replica that spent even one attempt on it would leave the new one
  // nothing to run, and it would be dead-lettered unrun.
  function newReleaseJob(runs: string[]) {
    return class NewReleaseJob extends Job {
      static name = "NewReleaseJob";
      maxAttempts = 1;
      run() {
        runs.push("new");
      }
    };
  }

  test("an old replica leaves a job only the new release has, and the new one runs it", async () => {
    const { driver, rows } = await database();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const runs: string[] = [];
    await driver().enqueue({ name: "NewReleaseJob", args: "[]" });

    const old = worker(driver(), [recorder("RecordRun", "old", [])]);
    old.start();
    // Many polls' worth. Before, the first one dead-lettered the job.
    await sleep(200);
    const [waiting] = await rows();
    expect(waiting).toMatchObject({ status: "pending" });
    expect(Number(waiting!.attempts)).toBe(0);
    // Filtered in the claim, so the old replica never even saw it.
    expect(error).not.toHaveBeenCalled();

    worker(driver(), [newReleaseJob(runs)]).start();
    await until(() => runs.length === 1);
    await until(async () => (await rows()).length === 0);
  });

  test("a driver that cannot filter by name gives the job back without spending its attempt", async () => {
    const { driver, rows } = await database();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runs: string[] = [];
    await driver().enqueue({ name: "NewReleaseJob", args: "[]" });

    // The database driver with `registered` stripped: the path a third-party
    // driver without name filtering takes, where the manager does the work.
    const inner = driver();
    const unfiltered: QueueDriver = {
      enqueue: (job) => inner.enqueue(job),
      claim: (limit, { visibilityTimeoutMs }) => inner.claim(limit, { visibilityTimeoutMs }),
      complete: (job) => inner.complete(job),
      fail: (job, failure) => inner.fail(job, failure),
      release: (job, release) => inner.release(job, release),
      heartbeat: (jobs, options) => inner.heartbeat(jobs, options),
    };
    const released = vi.spyOn(inner, "release");
    const old = worker(unfiltered, [recorder("RecordRun", "old", [])]);
    old.start();
    await until(() => released.mock.calls.length >= 3);
    // Out of the race before the new release starts: this is about what three
    // refusals cost the job, not about who wins it. Through `fail` they cost
    // three attempts, and the new replica would dead-letter it unrun.
    await old.drain(5_000);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", last_error: null });
    expect(Number(row!.attempts)).toBe(0);

    worker(driver(), [newReleaseJob(runs)]).start();
    await until(() => runs.length === 1);
    await until(async () => (await rows()).length === 0);
  });

  test("past the grace window a name nobody registered is dead-lettered, and the row says why", async () => {
    const { driver, rows } = await database();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await driver().enqueue({ name: "RemovedJob", args: "[]" });

    worker(driver(), [recorder("RecordRun", "any", [])], { unknownJobGrace: 150 }).start();

    await until(async () => (await rows())[0]?.status === "dead");
    const [dead] = await rows();
    expect(Number(dead!.attempts)).toBe(1);
    expect(String(dead!.last_error)).toContain('No job is registered under the name "RemovedJob"');
  });

  // #563. On Postgres and MySQL the row is written on the transaction; on
  // SQLite the manager holds the dispatch until the commit. The contract pins
  // which of the two each does; this is what either looks like from outside.
  test("a dispatch inside a transaction is neither recorded nor run before the commit", async () => {
    const { rows, application } = await database();
    const { sql, driver } = application();
    const runs: Array<{ n: number; worker: string }> = [];
    const Recorder = recorder("RecordRun", "here", runs);
    const queue = worker(driver, [Recorder]);
    queue.start();

    await withTransaction(sql, async () => {
      await queue.push(Recorder, "[1]");
      // Several polls: a row the claim could see would have been run by now.
      await sleep(150);
      expect(runs).toEqual([]);
      // Read on a client of its own, so this is what another replica sees.
      expect((await rows()).length).toBe(0);
    });

    await until(() => runs.length === 1);
    expect(runs).toEqual([{ n: 1, worker: "here" }]);
  });

  test("a dispatch inside a transaction that rolls back is never recorded or run", async () => {
    const { rows, application } = await database();
    const { sql, driver } = application();
    const runs: Array<{ n: number; worker: string }> = [];
    const Recorder = recorder("RecordRun", "here", runs);
    const queue = worker(driver, [Recorder]);
    queue.start();

    await expect(
      withTransaction(sql, async () => {
        await queue.push(Recorder, "[1]");
        throw new Error("card declined");
      }),
    ).rejects.toThrow("card declined");

    await sleep(150);
    expect(runs).toEqual([]);
    expect((await rows()).length).toBe(0);
  });

  test("a dispatch inside a transaction is claimed at the commit, not a poll interval later", async () => {
    const { application } = await database();
    const { sql, driver } = application();
    const runs: Array<{ n: number; worker: string }> = [];
    const Recorder = recorder("RecordRun", "here", runs);
    const queue = worker(driver, [Recorder], { pollInterval: 60_000 });
    queue.start();
    // Let the first, empty claim finish, so the loop is asleep on the poll.
    await sleep(50);

    await withTransaction(sql, async () => {
      await queue.push(Recorder, "[5]");
      // Long enough for a claim woken by the dispatch itself to have come
      // back empty, so only a wake at the commit can get the job run in time.
      await sleep(100);
    });
    await until(() => runs.length === 1, 1_000);
  });

  // #563's review. A job written on the transaction that fails aborts the
  // transaction on Postgres, and Bun's `COMMIT` after it is a rollback that
  // `begin` reports as success: without the commit waiting on the job, the
  // caller's rows vanished and its transaction resolved. A queued listener's
  // dispatch is never awaited, so "await the dispatch" is not a way out.
  // SQLite never joins (its held dispatch fails after the commit, which
  // stays), so there is nothing there to roll back.
  describe.skipIf(backend.dialect === "sqlite")(
    "a job written on the transaction that fails",
    () => {
      // A data table beside the jobs, and a driver on the default connection
      // whose own table was never created — an app whose jobs migration has
      // not run.
      async function unmigrated() {
        const { application } = await database();
        const { sql } = application();
        const orders = quoteTable(backend.dialect, `orders_${crypto.randomUUID().slice(0, 8)}`);
        await sql.unsafe(`CREATE TABLE ${orders} (id INT PRIMARY KEY)`);
        const previous = dispose;
        dispose = async () => {
          await sql.unsafe(`DROP TABLE IF EXISTS ${orders}`);
          await previous?.();
        };
        const driver = new DatabaseQueueDriver(
          { name: DEFAULT_CONNECTION, sql, dialect: backend.dialect },
          { table: `missing_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}` },
        );
        const count = async () =>
          Number(
            ((await sql.unsafe(`SELECT COUNT(*) AS n FROM ${orders}`)) as Array<{ n: unknown }>)[0]!
              .n,
          );
        return { sql, driver, orders, count };
      }

      /** The caller's own write, on the transaction the ORM would use. */
      const currentInsert = (orders: string, id = 1) =>
        currentTransaction()!.unsafe(`INSERT INTO ${orders} (id) VALUES (${id})`);

      const runs: Array<{ n: number; worker: string }> = [];
      const Noop = recorder("Noop", "here", runs);

      test("rolls the transaction back, and says so, when nobody awaited it", async () => {
        const { sql, driver, orders, count } = await unmigrated();
        const queue = worker(driver, [Noop]);
        // Stopped, so the push does not start a claim loop: on MySQL a claim
        // loop against a missing table also produces unhandled rejections
        // (Bun 1.3.14, with or without this change), which is not what this
        // test is about.
        await queue.drain(0);
        const failed = vi.fn();

        const outcome = withTransaction(sql, async () => {
          await currentInsert(orders);
          // As `EventManager` pushes a queued listener: not awaited.
          queue.push(Noop, "[]", { reportFailure: false }).catch(failed);
          return "ok";
        });

        await expect(outcome).rejects.toBeInstanceOf(TransactionDependencyError);
        expect(await count()).toBe(0);
        expect(failed).toHaveBeenCalledOnce();
      });

      test("rolls the transaction back when the caller awaited it and caught the error", async () => {
        const { sql, driver, orders, count } = await unmigrated();

        await expect(
          withTransaction(sql, async () => {
            await currentInsert(orders);
            await driver.enqueue({ name: "Noop", args: "[]" }).catch(() => "ignored");
          }),
        ).rejects.toBeInstanceOf(TransactionDependencyError);
        expect(await count()).toBe(0);
      });

      test("inside a savepoint rolls back only the savepoint, and a caller that catches keeps the rest", async () => {
        const { sql, driver, orders, count } = await unmigrated();

        await withTransaction(sql, async () => {
          await currentInsert(orders, 1);
          await expect(
            withTransaction(sql, async () => {
              await currentInsert(orders, 2);
              void driver.enqueue({ name: "Noop", args: "[]" }).catch(() => {});
            }),
          ).rejects.toBeInstanceOf(TransactionDependencyError);
        });
        expect(await count()).toBe(1);
      });
    },
  );

  test("a driver that cannot tell which connection it is on never joins a transaction", async () => {
    const { driver, application } = await database();
    const { sql } = application();
    const unnamed = driver();

    await withTransaction(sql, async () => {
      expect(unnamed.joinsTransaction()).toBe(false);
    });
  });

  test("a transaction on another connection is not one the driver joins", async () => {
    const { application } = await database();
    const { sql, driver } = application();

    await withTransaction(
      sql,
      async () => {
        expect(driver.joinsTransaction()).toBe(false);
      },
      { connection: "analytics" },
    );
  });

  test("a dead job retried through the queue runs again with all its attempts, without waiting out the poll", async () => {
    const { driver, rows } = await database();
    let broken = true;
    const runs: number[] = [];
    class Flaky extends Job {
      static name = "Flaky";
      maxAttempts = 2;
      run() {
        runs.push(Date.now());
        if (broken) throw new Error("smtp is down");
      }
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = worker(driver(), [Flaky], { pollInterval: 60_000 });
    const id = await queue.push(Flaky, "[]");
    await until(async () => (await rows())[0]?.status === "dead");
    expect(runs).toHaveLength(2);

    broken = false;
    expect(await queue.retryDead(id)).toBe(true);

    await until(() => runs.length === 3, 1_000);
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

  test("two workers run a batch, and its callbacks run once", async () => {
    const { driver, rows } = await database();
    const runs: Array<{ n: number; worker: string }> = [];
    const finished: Array<[string, BatchStatus]> = [];
    const callback = (worker: string) =>
      class Finished extends Job {
        static name = "Finished";
        run(label: string, status: BatchStatus) {
          finished.push([`${worker}:${label}`, status]);
        }
      };
    const a = worker(driver(), [recorder("RecordRun", "a", runs), callback("a")]);
    const b = worker(driver(), [recorder("RecordRun", "b", runs), callback("b")]);

    const Finished = callback("producer");
    const id = Bun.randomUUIDv7();
    await driver().enqueueBatch({
      id,
      name: "two-workers",
      job: "RecordRun",
      args: Array.from({ length: 30 }, (_, n) => JSON.stringify([n])),
      allowFailures: false,
      callbacks: { then: Finished.with("then"), finally: Finished.with("finally") },
    });
    a.start();
    b.start();

    await until(async () => finished.length === 2 && (await rows()).length === 0);
    // A second `then` would show up just after the first two.
    await sleep(100);

    expect(runs.map((run) => run.n).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 30 }, (_, n) => n),
    );
    expect(finished.map(([label]) => label.split(":")[1]).sort()).toEqual(["finally", "then"]);
    expect(finished[0]![1]).toMatchObject({ id, total: 30, succeeded: 30, pending: 0 });
    expect(await driver().findBatch(id)).toMatchObject({ succeeded: 30, progress: 1 });
  });

  test("a table from before batches still runs jobs, and createTable adds what batches need", async () => {
    const url = { postgres: POSTGRES_URL, mysql: MYSQL_URL }[backend.name] ?? ":memory:";
    const sql = new SQL(url);
    const table = `old_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const quoted = quoteTable(backend.dialect, table);
    const batches = quoteTable(backend.dialect, `${table}_batches`);
    const mysql = backend.dialect === "mysql";
    try {
      // The table as 0.116 created it: no batch_id, no progress.
      for (const statement of createTableStatements(backend.dialect, table)) {
        await sql.unsafe(statement);
      }
      await sql.unsafe(
        mysql
          ? `DROP INDEX \`${table}_batch_id_idx\` ON ${quoted}`
          : `DROP INDEX ${quoteTable(backend.dialect, `${table}_batch_id_idx`)}`,
      );
      await sql.unsafe(`ALTER TABLE ${quoted} DROP COLUMN ${mysql ? "`batch_id`" : '"batch_id"'}`);
      await sql.unsafe(`ALTER TABLE ${quoted} DROP COLUMN ${mysql ? "`progress`" : '"progress"'}`);

      const old = new DatabaseQueueDriver({ sql, dialect: backend.dialect }, { table });
      await old.enqueue({ name: "A", args: "[]" });
      const [claimed] = await old.claim(1, { visibilityTimeoutMs: 1000 });
      expect(claimed).toMatchObject({ name: "A", attempt: 1 });
      expect(claimed!.batchId).toBeUndefined();
      await old.complete(claimed!);

      const batch = {
        id: Bun.randomUUIDv7(),
        name: null,
        job: "A",
        args: ["[]"],
        allowFailures: false,
        callbacks: {},
      };
      await expect(old.enqueueBatch(batch)).rejects.toThrow("Job batches need");

      await old.createTable();
      await old.createTable();
      await old.enqueueBatch(batch);
      const [inBatch] = await old.claim(1, { visibilityTimeoutMs: 1000 });
      expect(inBatch!.batchId).toBe(batch.id);
      await old.complete(inBatch!);
      expect(await old.findBatch(batch.id)).toMatchObject({ succeeded: 1, pending: 0 });
    } finally {
      await sql.unsafe(`DROP TABLE IF EXISTS ${quoted}`);
      await sql.unsafe(`DROP TABLE IF EXISTS ${batches}`);
      await sql.close();
    }
  });

  test("a workflow started inside a transaction commits with it, or not at all", async () => {
    const { application } = await database();
    const { sql, driver } = application();
    const ran: number[] = [];
    class InTx extends Workflow {
      static name = "InTx";
      async run(step: Step, n: number) {
        await step.run("go", () => ran.push(n));
      }
    }
    const queue = worker(driver, [], { workflows: [InTx] });
    queue.start();

    let committed = "";
    await withTransaction(sql, async () => {
      committed = await queue.workflows.start(InTx, [1]);
    });
    await until(async () => (await queue.workflows.find(committed))?.status === "completed");

    let rolledBack = "";
    await expect(
      withTransaction(sql, async () => {
        rolledBack = await queue.workflows.start(InTx, [2]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await sleep(100);
    expect(await queue.workflows.find(rolledBack)).toBeNull();
    expect(ran).toEqual([1]);
  });

  test("ended workflows are pruned with their steps", async () => {
    const { driver } = await database();
    class Quick extends Workflow {
      static name = "Quick";
      async run(step: Step) {
        await step.run("one", () => 1);
      }
    }
    const queue = worker(driver(), [], { workflows: [Quick] });
    queue.start();
    const id = await queue.workflows.start(Quick, []);
    await until(async () => (await queue.workflows.find(id))?.status === "completed");

    const store = queue.workflows.store;
    expect(await store.prune!(60_000)).toBe(0);
    await sleep(20);
    expect(await store.prune!(0)).toBe(1);
    expect(await queue.workflows.find(id)).toBeNull();
  });

  test("a dead job of a batch is not retried, and finished batches are pruned", async () => {
    const { driver } = await database();
    const d = driver();
    const id = Bun.randomUUIDv7();
    await d.enqueueBatch({ id, name: null, job: "A", args: ["[]"], allowFailures: true, callbacks: {} });
    const [job] = await d.claim(1, { visibilityTimeoutMs: 1000 });
    await d.fail(job!, { error: "boom", retryInMs: null });

    expect(await d.retryDead(job!.id)).toBe(false);
    expect(await d.pruneBatches(60_000)).toBe(0);
    expect(await d.pruneBatches(0)).toBe(1);
    expect(await d.findBatch(id)).toBeNull();
  });
});

describe("DatabaseQueueDriver", () => {
  test("refuses a table name that is not a plain identifier", () => {
    const sql = new SQL(":memory:");
    expect(
      () => new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { table: "jobs; drop table x" }),
    ).toThrow("not a plain identifier");
  });

  test("a table named with a reserved word is quoted in every query, as createTable quotes it", async () => {
    const sql = new SQL(":memory:");
    const driver = new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { table: "order" });
    await driver.createTable();
    await driver.enqueue({ name: "A", args: "[]" });
    const [claimed] = await driver.claim(1, { visibilityTimeoutMs: 1000 });
    await driver.complete(claimed!);
    expect(await driver.claim(1, { visibilityTimeoutMs: 1000 })).toEqual([]);
    expect(await driver.prune(0)).toBe(0);
    await sql.close();
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
    expect(statement).toContain("INDEX `gemi_jobs_batch_id_idx`");
    const [batches, ...more] = createBatchTableStatements("mysql", "gemi_job_batches");
    expect(more).toEqual([]);
    expect(batches).toContain("CREATE TABLE IF NOT EXISTS `gemi_job_batches`");
    // Prisma's default VARCHAR(191) is too short for the list of failed ids.
    expect(batches).toContain("`failed_job_ids` LONGTEXT NOT NULL");
  });

  test("the workflow tables match Prisma's DDL for the documented models", () => {
    const [workflows, steps, index] = createWorkflowTableStatements(
      "postgres",
      "gemi_workflows",
      "gemi_workflow_steps",
    );
    expect(workflows).toContain(`"progress" DOUBLE PRECISION NOT NULL DEFAULT 0`);
    expect(workflows).toContain(`CONSTRAINT "gemi_workflows_pkey" PRIMARY KEY ("id")`);
    expect(steps).toContain(`CONSTRAINT "gemi_workflow_steps_pkey" PRIMARY KEY ("workflow_id","key")`);
    expect(index).toBe(
      `CREATE INDEX IF NOT EXISTS "gemi_workflows_status_idx" ON "gemi_workflows"("status")`,
    );
    const [sqliteSteps] = createWorkflowTableStatements("sqlite", "w", "s").slice(1);
    expect(sqliteSteps).toContain(`PRIMARY KEY ("workflow_id", "key")`);
    const mysql = createWorkflowTableStatements("mysql", "gemi_workflows", "gemi_workflow_steps");
    expect(mysql).toHaveLength(2);
    expect(mysql[0]).toContain("INDEX `gemi_workflows_status_idx`(`status`)");
    expect(mysql[0]).toContain("`result` LONGTEXT NULL");
    expect(mysql[1]).toContain("PRIMARY KEY (`workflow_id`, `key`)");
  });

  test("the workflow tables sit beside the jobs table", () => {
    const sql = new SQL("sqlite://:memory:");
    const plain = new DatabaseQueueDriver({ sql, dialect: "sqlite" });
    expect([plain.workflowTable, plain.workflowStepTable]).toEqual([
      "gemi_workflows",
      "gemi_workflow_steps",
    ]);
    const other = new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { table: "jobs" });
    expect([other.workflowTable, other.workflowStepTable]).toEqual([
      "jobs_workflows",
      "jobs_workflow_steps",
    ]);
    expect(
      () => new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { workflowTable: "x; drop" }),
    ).toThrow("not a plain identifier");
  });

  test("workflows on a database without their tables fail with what to do", async () => {
    const sql = new SQL("sqlite://:memory:");
    const driver = new DatabaseQueueDriver({ sql, dialect: "sqlite" });
    await expect(
      driver.workflowStore().create({ id: "w", name: "W", args: "[]" }),
    ).rejects.toThrow("Workflows need the");
  });

  test("the batches table is gemi_job_batches beside gemi_jobs, and <table>_batches otherwise", () => {
    const sql = new SQL(":memory:");
    expect(new DatabaseQueueDriver({ sql, dialect: "sqlite" }).batchTable).toBe("gemi_job_batches");
    expect(
      new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { table: "jobs" }).batchTable,
    ).toBe("jobs_batches");
    expect(
      new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { batchTable: "batches" }).batchTable,
    ).toBe("batches");
    expect(
      () => new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { batchTable: "x; drop" }),
    ).toThrow("not a plain identifier");
  });
});

describe("DatabaseQueueDriver on a SQLite file another process is writing", () => {
  /**
   * A second process holding the file's write lock for `ms`. Resolves once it
   * has the lock, to a promise of its exit. A process and not a second client here: Bun runs SQLite on the
   * JavaScript thread, so a lock held from this one could never be released
   * while a statement of ours sat waiting on it.
   */
  async function lockFor(path: string, ms: number) {
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(path)});
         db.run("BEGIN IMMEDIATE");
         db.run("CREATE TABLE held (x INTEGER)");
         console.log("locked");
         Bun.sleepSync(${ms});
         db.run("COMMIT");`,
      ],
      { stdout: "pipe" },
    );
    const { value } = await holder.stdout.getReader().read();
    if (!new TextDecoder().decode(value).includes("locked")) {
      throw new Error("the lock holder exited without taking the lock");
    }
    return { released: holder.exited };
  }

  async function file() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-queue-busy-"));
    const path = join(dir, "jobs.db");
    const sql = new SQL(`sqlite://${path}`);
    return {
      path,
      sql,
      async dispose() {
        await sql.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("waits out the other process's write instead of failing with SQLITE_BUSY", async () => {
    const db = await file();
    try {
      const driver = new DatabaseQueueDriver({ sql: db.sql, dialect: "sqlite" });
      await driver.createTable();
      const { released } = await lockFor(db.path, 300);

      // Bun opens SQLite with busy_timeout 0, so without the driver's own
      // this INSERT is refused the moment it finds the lock taken.
      await driver.enqueue({ name: "A", args: "[]" });

      await released;
      expect(await driver.claim(1, { visibilityTimeoutMs: 1000 })).toHaveLength(1);
    } finally {
      await db.dispose();
    }
  });

  test("leaves a connection whose busy timeout was already set, and busyTimeout 0 leaves any", async () => {
    const db = await file();
    try {
      await db.sql.unsafe("PRAGMA busy_timeout = 250");
      await new DatabaseQueueDriver({ sql: db.sql, dialect: "sqlite" }).createTable();
      expect([...(await db.sql.unsafe("PRAGMA busy_timeout"))]).toEqual([{ timeout: 250 }]);

      await db.sql.unsafe("PRAGMA busy_timeout = 0");
      await new DatabaseQueueDriver(
        { sql: db.sql, dialect: "sqlite" },
        { busyTimeout: 0 },
      ).createTable();
      expect([...(await db.sql.unsafe("PRAGMA busy_timeout"))]).toEqual([{ timeout: 0 }]);
    } finally {
      await db.dispose();
    }
  });

  test("refuses a busyTimeout that is not a whole, non-negative number", () => {
    const sql = new SQL(":memory:");
    expect(() => new DatabaseQueueDriver({ sql, dialect: "sqlite" }, { busyTimeout: -1 })).toThrow(
      "busyTimeout",
    );
  });
});
