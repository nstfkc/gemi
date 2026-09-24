import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONNECTION } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { TransactionDependencyError, currentTransaction, withTransaction } from "../../orm/context";
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
      transaction: {
        run: (driver, fn) => withTransaction(clients.get(driver)!, fn),
        // See `DatabaseQueueDriver.transaction` for why SQLite never joins.
        joins: backend.dialect !== "sqlite",
      },
    },
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
  });
});
