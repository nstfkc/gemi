import type { SQL, TransactionSQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { DatabaseLockStore } from "../lock/DatabaseLockStore";
import { commitDependsOn, currentConnectionName, currentTransaction } from "../../orm/context";
import {
  type BatchCallbacks,
  type BatchOutcome,
  type BatchRecord,
  type BatchStatus,
  cancelsBatch,
  clampProgress,
  countOutcome,
  markCancelled,
  newBatchRecord,
  settle,
  statusOf,
} from "./batch";
import type {
  ClaimOptions,
  ClaimedJob,
  EnqueueBatch,
  EnqueueJob,
  JobFailure,
  JobRelease,
  QueueDriver,
} from "./QueueDriver";
import {
  DatabaseWorkflowStore,
  createWorkflowTableStatements,
} from "./workflow/DatabaseWorkflowStore";

export type DatabaseQueueDriverOptions = {
  /**
   * The jobs table. Default `gemi_jobs`. A plain identifier — letters, digits
   * and underscores — because it is spliced into every statement.
   */
  table?: string;
  /**
   * The table batches are kept in. Default `gemi_job_batches` beside
   * `gemi_jobs`, and `<table>_batches` beside a jobs table of another name.
   * A plain identifier, like `table`. Only touched by `Job.dispatchBatch` and
   * the batch methods.
   */
  batchTable?: string;
  /**
   * The tables workflows are kept in. Default `gemi_workflows` and
   * `gemi_workflow_steps` beside `gemi_jobs`, and `<table>_workflows` and
   * `<table>_workflow_steps` beside a jobs table of another name. Plain
   * identifiers, like `table`. Only touched by `Workflow`.
   */
  workflowTable?: string;
  workflowStepTable?: string;
  /**
   * SQLite only: how long, in milliseconds, a statement waits for another
   * process's write lock before failing with `SQLITE_BUSY`. Default `1000`.
   * Applied only to a connection whose busy timeout is still SQLite's `0`, so
   * one the application configured itself keeps its own; `0` here leaves the
   * connection alone. See `configure` for what the wait costs.
   */
  busyTimeout?: number;
};

/**
 * What a row's `status` can be. `pending` rows are claimable once
 * `available_at` has passed; `claimed` ones once `lease_expires_at` has. `dead`
 * is terminal and kept, with `last_error`, until `prune` removes it. A
 * completed job is deleted, so there is no status for it.
 */
export type DatabaseJobStatus = "pending" | "claimed" | "dead";

type Row = {
  id: string;
  name: string;
  payload: string;
  attempts: number | string;
  available_at: number | string | bigint;
  created_at: number | string | bigint;
  /** Absent on a table from before batches; see `claim`. */
  batch_id?: string | null;
};

type BatchRow = {
  id: string;
  name: string | null;
  total: number | string;
  pending: number | string;
  succeeded: number | string;
  failed: number | string;
  cancelled: number | string;
  failed_job_ids: string;
  options: string;
  cancelled_at: number | string | bigint | null;
  finished_at: number | string | bigint | null;
  created_at: number | string | bigint;
};

/** How many job rows one `INSERT` of a batch carries. */
const BATCH_INSERT_CHUNK = 200;

/** The `last_error` of a waiting job ended by its batch's cancellation. */
const CANCELLED_ERROR = "Its batch was cancelled before it ran.";

/**
 * A driver that keeps jobs in a table of the application's own database, so
 * they outlive the process: a job dispatched before a deploy, a scale-in or a
 * crash is still there afterwards, and any process sharing the database claims
 * it — the one waiting at once, the one that was running once its lease runs
 * out. Nothing replays anything at boot; claiming is the recovery.
 *
 * **At least once, not exactly once.** A job whose lease lapses while it is
 * still running — its process frozen, or unable to reach the database to
 * heartbeat, for longer than the visibility timeout — can be claimed and run
 * by another process too, and a job whose process died after its work but
 * before `complete` reached the database runs again. Jobs must be idempotent.
 *
 * ### Claiming
 *
 * Postgres and MySQL lock the rows they hand out with `FOR UPDATE SKIP
 * LOCKED`, so concurrent claimers — in this process or any other — each take
 * different rows and none waits on another. Postgres does it in one statement
 * (a locking CTE feeding an `UPDATE … RETURNING`); MySQL has no `RETURNING`
 * and refuses a `LIMIT` inside `IN (…)`, so there it is a `SELECT … FOR
 * UPDATE SKIP LOCKED` and one `UPDATE` per row in a transaction, at READ
 * COMMITTED and in two passes — see `claimLocking`, where both are load
 * bearing rather than tidying. SQLite has no row locks and needs none: it
 * runs one write at a time, so a single `UPDATE … RETURNING` is atomic.
 * MariaDB needs 10.6 for `SKIP LOCKED`.
 *
 * It honours `registered`: a claim is `WHERE name IN (…)` the claimer's
 * registry, so a replica never takes a job it has no class for until that job
 * has been claimable for the grace window. Every replica claims from this one
 * table, and during a blue/green ramp half of them are running the other
 * release.
 *
 * ### Time
 *
 * Every time in the table is epoch milliseconds, read from the database's
 * clock rather than this process's, so replicas with skewed clocks still agree
 * on when a lease ran out. Integers rather than timestamp columns so the same
 * arithmetic works in all three dialects.
 *
 * ### Transactions
 *
 * On Postgres and MySQL, a dispatch inside an ORM transaction on this
 * driver's own connection is written on that transaction: the row commits
 * with the data it describes or not at all, and no claimer — each reads
 * through a pooled connection of its own — sees it before the commit. See
 * `transaction` below for why SQLite is left out, and why a driver built from
 * a bare client never joins.
 *
 * ### Batches
 *
 * A batch is a row of `batchTable`, and its jobs are rows of the jobs table
 * with `batch_id` set. Ending a job of a batch, counting it and enqueueing any
 * callback it makes due happen in one transaction that locks the batch row
 * first; see the "Batches" section below. A table from before batches, without
 * `batch_id` and `progress`, still runs every other job: the claim reads `*`,
 * and only the batch methods need the new columns.
 *
 * ### What it does not do
 *
 * It has no `subscribe`: another process's dispatch cannot wake this one, so
 * the queue polls every `pollInterval` (and wakes itself for its own
 * dispatches).
 */
export class DatabaseQueueDriver implements QueueDriver {
  readonly table: string;
  readonly batchTable: string;
  readonly workflowTable: string;
  readonly workflowStepTable: string;
  private workflows: DatabaseWorkflowStore | undefined;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  /** The connection's name, when it came with one; see `transaction`. */
  private readonly connection: string | undefined;
  private readonly busyTimeout: number;
  private configured: Promise<void> | undefined;
  /** SQLite: the transaction before the next; see `atomically`. */
  private sqliteTail: Promise<unknown> = Promise.resolve();

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect"> &
      Partial<Pick<DatabaseConnection, "name">>,
    options: DatabaseQueueDriverOptions = {},
  ) {
    const table = options.table ?? "gemi_jobs";
    const batchTable =
      options.batchTable ?? (table === "gemi_jobs" ? "gemi_job_batches" : `${table}_batches`);
    const defaults = table === "gemi_jobs";
    const workflowTable =
      options.workflowTable ?? (defaults ? "gemi_workflows" : `${table}_workflows`);
    const workflowStepTable =
      options.workflowStepTable ??
      (defaults ? "gemi_workflow_steps" : `${table}_workflow_steps`);
    for (const name of [table, batchTable, workflowTable, workflowStepTable]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(
          `The queue table name "${name}" is not a plain identifier. Use ` +
            `letters, digits and underscores.`,
        );
      }
    }
    const busyTimeout = options.busyTimeout ?? 1000;
    if (!Number.isInteger(busyTimeout) || busyTimeout < 0) {
      throw new Error(
        `The queue's busyTimeout must be a whole number of milliseconds, 0 or more; got ${busyTimeout}.`,
      );
    }
    this.table = table;
    this.batchTable = batchTable;
    this.workflowTable = workflowTable;
    this.workflowStepTable = workflowStepTable;
    this.sql = connection.sql;
    this.dialect = connection.dialect;
    this.connection = connection.name;
    this.busyTimeout = busyTimeout;
  }

  /**
   * Gives a SQLite connection a busy timeout, once, before the driver's first
   * statement on it.
   *
   * Bun opens SQLite with `busy_timeout` 0, so a statement that finds another
   * process holding the file's write lock fails at once with `SQLITE_BUSY`.
   * Two processes on one file — `gemi dev` and a script that dispatches, or
   * the dev server and a seed — then lose writes at random: a dispatch whose
   * INSERT is refused is a job that never runs, and a `complete` that is
   * refused leaves the row claimed until its lease lapses and runs it again.
   * With a timeout SQLite retries the lock for that long instead.
   *
   * The wait is not free. Bun runs SQLite on the JavaScript thread, and the
   * busy handler sleeps there: while one statement waits out another
   * process's transaction, this process serves nothing else — measured, a
   * timer due every 10ms did not fire once across a 400ms wait. Hence a
   * second rather than the several a dedicated worker would choose; a lock
   * held longer than that still fails as it did before.
   *
   * On the connection, not on the driver's statements, because SQLite has no
   * other place for it — so it is the application's default connection's
   * setting too whenever the queue shares that connection, as `"database"`
   * does. That is why a connection already set to anything but 0 is left as
   * it is. Lazily rather than from the constructor, because a driver built
   * over a connection that is closed unused would otherwise leave a pragma
   * rejecting against it with nobody holding the promise. Retried after a
   * failure rather than remembered, so one lost statement does not fail every
   * later one.
   */
  private configure(): Promise<void> {
    if (this.dialect !== "sqlite" || this.busyTimeout === 0) return Promise.resolve();
    this.configured ??= (async () => {
      const [current] = (await this.sql.unsafe("PRAGMA busy_timeout")) as Array<{
        timeout: number | string;
      }>;
      if (Number(current?.timeout ?? 0) !== 0) return;
      await this.sql.unsafe(`PRAGMA busy_timeout = ${this.busyTimeout}`);
    })().catch((error) => {
      this.configured = undefined;
      throw error;
    });
    return this.configured;
  }

  /**
   * Creates the jobs table, the batches table, the two workflow tables and
   * their indexes if they do not exist — the same DDL Prisma generates for
   * the models in the docs, so
   * a table made either way is the table the other expects — and adds the
   * batch columns to a jobs table from before batches. For tests and for an
   * app that does not manage its schema with Prisma; one that does should add
   * the models instead, or `prisma migrate` will see tables it does not know
   * and drop them.
   */
  async createTable(): Promise<void> {
    await this.configure();
    // The table first and its indexes after any upgrade, because one of them
    // is on `batch_id`, which a table from before batches does not have yet.
    const [table, ...indexes] = createTableStatements(this.dialect, this.table);
    await this.sql.unsafe(table!);
    if (!(await this.hasBatchColumns())) {
      for (const statement of addBatchColumnsStatements(this.dialect, this.table)) {
        await this.sql.unsafe(statement);
      }
    }
    for (const statement of indexes) await this.sql.unsafe(statement);
    for (const statement of createBatchTableStatements(this.dialect, this.batchTable)) {
      await this.sql.unsafe(statement);
    }
    for (const statement of createWorkflowTableStatements(
      this.dialect,
      this.workflowTable,
      this.workflowStepTable,
    )) {
      await this.sql.unsafe(statement);
    }
  }

  /** Whether the jobs table has `batch_id` and `progress` yet. */
  private async hasBatchColumns(): Promise<boolean> {
    try {
      await this.sql.unsafe(`SELECT batch_id, progress FROM ${this.quoted(this.table)} WHERE 1 = 0`);
      return true;
    } catch (error) {
      if (isMissingSchema(error)) return false;
      throw error;
    }
  }

  enqueue(job: EnqueueJob): Promise<string> {
    // Read here, at the call, and never kept: Bun's handle stays callable
    // after its transaction ends and then runs on the pool, so a stored one
    // would write outside any transaction and succeed.
    const tx = this.transaction();
    const written = this.insert(tx ?? this.sql, job);
    // A row written on the transaction is part of it, so the commit waits for
    // it and does not happen if it failed. Otherwise a dispatch nobody awaits
    // — every queued listener's — that fails on Postgres aborts the
    // transaction, and the `COMMIT` that follows is quietly a rollback that
    // `begin` reports as success: the caller's rows are gone with no error.
    // Registered synchronously, while the caller's scope is current.
    if (tx) commitDependsOn(written);
    return written;
  }

  private async insert(
    q: SQL,
    { name, args, delayMs = 0, id = Bun.randomUUIDv7() }: EnqueueJob,
  ): Promise<string> {
    await this.configure();
    const now = this.now(q);
    await q`
      INSERT INTO ${this.name(q)}
        (id, name, payload, status, attempts, available_at, created_at, updated_at)
      VALUES
        (${id}, ${name}, ${args}, 'pending', 0, ${now} + ${this.ms(q, delayMs)}, ${now}, ${now})
    `;
    return id;
  }

  /**
   * Locks in the `gemi_locks` table of the same connection, so unique jobs,
   * `withoutOverlapping` and `onOneServer` hold across every process sharing
   * this database. The table is only touched when one of those is used.
   */
  lockStore(): DatabaseLockStore {
    return new DatabaseLockStore(
      { sql: this.sql, dialect: this.dialect, name: this.connection },
      { busyTimeout: this.busyTimeout },
    );
  }

  joinsTransaction(): boolean {
    return this.transaction() !== undefined;
  }

  /**
   * The open ORM transaction, when an `enqueue` should be written on it.
   *
   * Only one on this driver's own connection, matched by name as the ORM and
   * the `DB` facade match it: the transaction's handle does not say which
   * pool it came from. A driver built from a bare `{ sql, dialect }` has no
   * name to match, so it never joins, and the manager holds its dispatches
   * until the commit instead. Guessing "default" there would write a job
   * into whichever database the default connection is, which need not be the
   * one this driver's table is in.
   *
   * Never on SQLite. Bun gives a SQLite client one connection, and a
   * statement on the pool while a transaction is open runs *inside* that
   * transaction — measured on Bun 1.3.14: it sees the transaction's
   * uncommitted rows. The queue claims through the pool, so a job row
   * written on the transaction would be visible to this process's own claim
   * before the commit, and run before the data it describes exists — or
   * whether or not it ever does. Held until the commit, it cannot.
   */
  private transaction(): TransactionSQL | undefined {
    if (this.dialect === "sqlite" || this.connection === undefined) return undefined;
    const tx = currentTransaction();
    if (tx === undefined || currentConnectionName() !== this.connection) return undefined;
    return tx;
  }

  async claim(limit: number, options: ClaimOptions): Promise<ClaimedJob[]> {
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];
    await this.configure();

    const rows =
      this.dialect === "mysql" || this.dialect === "mariadb"
        ? await this.claimLocking(count, options)
        : await this.claimUpdating(count, options);

    // `RETURNING` promises no order, and the manager expects oldest first.
    //
    // Every column is read back (`*`) rather than a list, so that `batch_id`
    // comes back where the table has it and the claim still works on a table
    // from before batches, which never has a batch job in it.
    return rows
      .map((row) => ({
        order: Number(row.available_at),
        job: {
          id: String(row.id),
          name: String(row.name),
          args: String(row.payload),
          attempt: Number(row.attempts),
          createdAt: Number(row.created_at),
          ...(row.batch_id == null ? {} : { batchId: String(row.batch_id) }),
        },
      }))
      .sort((a, b) => a.order - b.order || (a.job.id < b.job.id ? -1 : 1))
      .map(({ job }) => job);
  }

  async complete(job: ClaimedJob): Promise<void> {
    if (job.batchId !== undefined) return this.endBatchJob(job, "succeeded");
    await this.configure();
    const q = this.sql;
    await q`
      DELETE FROM ${this.name(q)}
      WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
    `;
  }

  async fail(job: ClaimedJob, failure: JobFailure): Promise<void> {
    if (job.batchId !== undefined) return this.endBatchJob(job, "failed", failure);
    await this.configure();
    const q = this.sql;
    const now = this.now(q);
    if (failure.retryInMs === null) {
      await q`
        UPDATE ${this.name(q)}
        SET status = 'dead', lease_expires_at = NULL, last_error = ${failure.error},
            updated_at = ${now}
        WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
      `;
      return;
    }
    await q`
      UPDATE ${this.name(q)}
      SET status = 'pending', available_at = ${now} + ${this.ms(q, failure.retryInMs)},
          lease_expires_at = NULL, last_error = ${failure.error}, updated_at = ${now}
      WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
    `;
  }

  /**
   * `attempts - 1`, so the attempt this claim added is taken back. Guarded by
   * the claim's attempt like every other report, so it can only undo the
   * increment it is reporting on.
   */
  async release(job: ClaimedJob, release: JobRelease): Promise<void> {
    const q = this.sql;
    const now = this.now(q);
    await q`
      UPDATE ${this.name(q)}
      SET status = 'pending', attempts = attempts - 1,
          available_at = ${now} + ${this.ms(q, release.retryInMs)},
          lease_expires_at = NULL, updated_at = ${now}
      WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
    `;
  }

  /**
   * Extends a lease that has lapsed but not been re-issued, too, as the memory
   * driver does: the job is still running here and nobody else has it.
   */
  async heartbeat(jobs: ClaimedJob[], options: ClaimOptions): Promise<void> {
    await this.configure();
    const q = this.sql;
    await Promise.all(
      jobs.map((job) => {
        const now = this.now(q);
        return q`
          UPDATE ${this.name(q)}
          SET lease_expires_at = ${now} + ${this.ms(q, options.visibilityTimeoutMs)},
              updated_at = ${now}
          WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
        `;
      }),
    );
  }

  /**
   * Puts a dead row back to waiting with its attempts reset, so the job gets
   * its whole `maxAttempts` again. `last_error` is kept until the next failure
   * replaces it, so the reason it died is still there to read while it runs.
   */
  async retryDead(id: string): Promise<boolean> {
    await this.configure();
    const q = this.sql;
    // A job of a batch has been counted as failed or cancelled already, and
    // its batch may have finished and run its callbacks. Run again, it would
    // be counted a second time.
    const [dead] = (await q`
      SELECT * FROM ${this.name(q)} WHERE id = ${id} AND status = 'dead'
    `) as Row[];
    if (!dead || dead.batch_id != null) return false;
    const now = this.now(q);
    const result = await q`
      UPDATE ${this.name(q)}
      SET status = 'pending', attempts = 0, available_at = ${now}, lease_expires_at = NULL,
          updated_at = ${now}
      WHERE id = ${id} AND status = 'dead'
    `;
    return affected(result) > 0;
  }

  /**
   * Deletes dead-lettered jobs last touched more than `olderThanMs` ago, and
   * resolves to how many. Dead rows are kept so a failure can be read and the
   * job brought back with `retryDead`; nothing removes them unless this is called — from
   * a scheduled job, say.
   */
  async prune(olderThanMs: number): Promise<number> {
    await this.configure();
    const q = this.sql;
    const result = await q`
      DELETE FROM ${this.name(q)}
      WHERE status = 'dead' AND updated_at <= ${this.now(q)} - ${this.ms(q, olderThanMs)}
    `;
    return affected(result);
  }

  // ---------------------------------------------------------------------
  // Batches
  //
  // A batch is a row in `batchTable` with its counters, and its jobs are
  // ordinary rows of the jobs table with `batch_id` set. Every change to the
  // counters happens in a transaction that first locks the batch row, so the
  // ends of two jobs of one batch are counted one after the other, and the
  // one that brings `pending` to 0 is the only one that sees it reach 0. The
  // job's own row is ended in that transaction, guarded by its attempt like
  // every other report, so a stale claim neither ends the job nor counts it;
  // and the callback jobs that become due are inserted in it, so they commit
  // with the count or not at all. That is the whole of "exactly once".
  //
  // Locks are always taken batch row first, then job rows, so the driver's
  // own transactions cannot deadlock on each other.
  // ---------------------------------------------------------------------

  enqueueBatch(batch: EnqueueBatch): Promise<void> {
    // On the caller's transaction when it is one this driver joins, as
    // `enqueue` is; otherwise in a transaction of its own, so a batch is
    // never half recorded.
    const tx = this.transaction();
    const written = tx
      ? this.insertBatch(tx, batch)
      : this.atomically((q) => this.insertBatch(q, batch));
    if (tx) commitDependsOn(written);
    return written;
  }

  private async insertBatch(q: SQL, batch: EnqueueBatch): Promise<void> {
    await this.configure();
    const now = await this.clock(q);
    const record = newBatchRecord({ ...batch, total: batch.args.length, now });
    // A batch of no jobs is finished as soon as it exists.
    const { record: settled, calls } = settle(record, record, now);
    await explainMissingSchema(
      q`
        INSERT INTO ${this.batches(q)}
          (id, name, total, pending, succeeded, failed, cancelled, failed_job_ids, options,
           cancelled_at, finished_at, created_at, updated_at)
        VALUES
          (${settled.id}, ${settled.name}, ${settled.total}, ${settled.pending}, 0, 0, 0,
           '[]', ${batchOptions(settled)}, NULL, ${this.timeOrNull(q, settled.finishedAt)},
           ${this.ms(q, now)}, ${this.ms(q, now)})
      `,
      this.batchTable,
    );

    const at = this.ms(q, now);
    for (let start = 0; start < batch.args.length; start += BATCH_INSERT_CHUNK) {
      const rows = batch.args
        .slice(start, start + BATCH_INSERT_CHUNK)
        .map(
          (args) =>
            q`(${Bun.randomUUIDv7()}, ${batch.job}, ${args}, 'pending', 0, ${at}, ${at}, ${at}, ${batch.id}, 0)`,
        )
        .reduce((list, row) => q`${list}, ${row}`);
      await explainMissingSchema(
        q`
          INSERT INTO ${this.name(q)}
            (id, name, payload, status, attempts, available_at, created_at, updated_at, batch_id, progress)
          VALUES ${rows}
        `,
        this.table,
      );
    }
    for (const call of calls) await this.insert(q, call);
  }

  async findBatch(id: string, options: { progress?: boolean } = {}): Promise<BatchStatus | null> {
    await this.configure();
    const q = this.sql;
    const [row] = (await explainMissingSchema(
      q`SELECT * FROM ${this.batches(q)} WHERE id = ${id}`,
      this.batchTable,
    )) as BatchRow[];
    if (!row) return null;
    const record = batchRecord(row);
    if (options.progress === false || record.pending === 0) return statusOf(record);
    const [sum] = (await q`
      SELECT COALESCE(SUM(progress), 0) AS running FROM ${this.name(q)}
      WHERE batch_id = ${id} AND status IN ('pending', 'claimed')
    `) as Array<{ running: unknown }>;
    return statusOf(record, Number(sum?.running ?? 0));
  }

  async cancelBatch(id: string): Promise<boolean> {
    return this.atomically((q) => this.cancelBatchOn(q, id));
  }

  /** `cancelBatch`, inside a transaction the caller has open. */
  private async cancelBatchOn(q: SQL, id: string): Promise<boolean> {
    const prev = await this.lockBatch(q, id);
    if (!prev || prev.finishedAt !== null || prev.cancelledAt !== null) return false;
    const now = await this.clock(q);
    const next = markCancelled(prev, now, await this.cancelWaiting(q, id));
    await this.saveBatch(q, prev, next, now);
    return true;
  }

  /**
   * Workflows (#846), in `workflowTable` and `workflowStepTable` of this
   * driver's database. Their writes share this driver's transactions, so a
   * step's record and the tick or batch it schedules commit together.
   */
  workflowStore(): DatabaseWorkflowStore {
    this.workflows ??= new DatabaseWorkflowStore(
      {
        sql: this.sql,
        dialect: this.dialect,
        connection: this.connection,
        configure: () => this.configure(),
        atomically: (fn) => this.atomically(fn),
        transaction: () => this.transaction(),
        now: (q) => this.now(q),
        ms: (q, value) => this.ms(q, value),
        timeOrNull: (q, value) => this.timeOrNull(q, value),
        fraction: (q, value) => this.fraction(q, value),
        clock: (q) => this.clock(q),
        insertJob: (q, job) => this.insert(q, job),
        insertBatch: (q, batch) => this.insertBatch(q, batch),
        cancelBatch: (q, id) => this.cancelBatchOn(q, id),
        quoted: (table) => this.quoted(table),
      },
      { table: this.workflowTable, stepTable: this.workflowStepTable },
    );
    return this.workflows;
  }

  async reportProgress(job: ClaimedJob, progress: number): Promise<void> {
    const value = clampProgress(progress);
    await this.configure();
    const q = this.sql;
    await q`
      UPDATE ${this.name(q)} SET progress = ${this.fraction(q, value)}
      WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
    `;
  }

  /**
   * Deletes batches that finished more than `olderThanMs` ago, and resolves
   * to how many. Nothing else removes them; a finished batch is only kept so
   * `findBatch` can still answer for it.
   */
  async pruneBatches(olderThanMs: number): Promise<number> {
    await this.configure();
    const q = this.sql;
    const result = await q`
      DELETE FROM ${this.batches(q)}
      WHERE finished_at IS NOT NULL AND finished_at <= ${this.now(q)} - ${this.ms(q, olderThanMs)}
    `;
    return affected(result);
  }

  /**
   * `complete` and `fail` for a job of a batch: the job's row is ended and the
   * batch counts it, in one transaction.
   */
  private endBatchJob(job: ClaimedJob, kind: "succeeded" | "failed", failure?: JobFailure) {
    const batchId = job.batchId!;
    return this.atomically(async (q) => {
      const prev = await this.lockBatch(q, batchId);
      const guard = q`id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}`;
      const now = this.now(q);

      if (kind === "succeeded") {
        const result = await q`DELETE FROM ${this.name(q)} WHERE ${guard}`;
        if (affected(result) === 0 || !prev) return;
        return this.count(q, prev, "succeeded", job.id);
      }

      const cancelled =
        failure!.cancelled === true ||
        (failure!.retryInMs !== null && prev !== undefined && prev.cancelledAt !== null);
      if (failure!.retryInMs !== null && !cancelled) {
        // A retry starts its share of the batch's progress from 0 again.
        await q`
          UPDATE ${this.name(q)}
          SET status = 'pending', available_at = ${now} + ${this.ms(q, failure!.retryInMs)},
              lease_expires_at = NULL, last_error = ${failure!.error}, progress = 0,
              updated_at = ${now}
          WHERE ${guard}
        `;
        return;
      }

      const result = await q`
        UPDATE ${this.name(q)}
        SET status = 'dead', lease_expires_at = NULL, last_error = ${failure!.error},
            updated_at = ${now}
        WHERE ${guard}
      `;
      if (affected(result) === 0 || !prev) return;
      return this.count(q, prev, cancelled ? "cancelled" : "failed", job.id);
    });
  }

  /** Counts one job's end against its locked batch row. */
  private async count(q: SQL, prev: BatchRecord, outcome: BatchOutcome, jobId: string) {
    const now = await this.clock(q);
    let next = countOutcome(prev, outcome, jobId);
    if (cancelsBatch(prev, next)) {
      next = markCancelled(next, now, await this.cancelWaiting(q, prev.id));
    }
    await this.saveBatch(q, prev, next, now);
  }

  /**
   * Ends the batch's waiting jobs as cancelled — kept as dead rows that say
   * why — and resolves to how many there were. Their rows are locked after
   * the batch row, the order every batch transaction takes.
   */
  private async cancelWaiting(q: SQL, batchId: string): Promise<number> {
    const now = this.now(q);
    const result = await q`
      UPDATE ${this.name(q)}
      SET status = 'dead', last_error = ${CANCELLED_ERROR}, updated_at = ${now}
      WHERE batch_id = ${batchId} AND status = 'pending'
    `;
    return affected(result);
  }

  /** Writes the batch's new counters and enqueues the callbacks they made due. */
  private async saveBatch(q: SQL, prev: BatchRecord, next: BatchRecord, now: number) {
    const { record, calls } = settle(prev, next, now);
    await q`
      UPDATE ${this.batches(q)}
      SET pending = ${record.pending}, succeeded = ${record.succeeded}, failed = ${record.failed},
          cancelled = ${record.cancelled}, failed_job_ids = ${JSON.stringify(record.failedJobIds)},
          cancelled_at = ${this.timeOrNull(q, record.cancelledAt)},
          finished_at = ${this.timeOrNull(q, record.finishedAt)}, updated_at = ${this.ms(q, now)}
      WHERE id = ${record.id}
    `;
    for (const call of calls) await this.insert(q, call);
  }

  /**
   * Reads the batch row and holds it until the transaction ends. Postgres and
   * MySQL lock the row; SQLite has no row locks, so a write to the row takes
   * the file's write lock instead, waiting out another process's for the
   * busy timeout rather than failing on the upgrade from a read lock.
   */
  private async lockBatch(q: SQL, id: string): Promise<BatchRecord | undefined> {
    let rows: BatchRow[];
    if (this.dialect === "sqlite") {
      await q`UPDATE ${this.batches(q)} SET updated_at = updated_at WHERE id = ${id}`;
      rows = await q`SELECT * FROM ${this.batches(q)} WHERE id = ${id}`;
    } else {
      rows = await q`SELECT * FROM ${this.batches(q)} WHERE id = ${id} FOR UPDATE`;
    }
    return rows[0] ? batchRecord(rows[0]) : undefined;
  }

  /**
   * Runs `fn` in a transaction of the driver's own.
   *
   * On SQLite one at a time per driver. Bun gives a SQLite client a single
   * connection, and a second `begin` on it while one is open is refused with
   * "cannot start a transaction within a transaction". One the application
   * has open on the same client — an ORM transaction, when the queue shares
   * the default connection — is waited out the same way, a few times.
   */
  private atomically<T>(fn: (q: SQL) => Promise<T>): Promise<T> {
    const run = async () => {
      await this.configure();
      for (let attempt = 0; ; attempt++) {
        try {
          return (await this.sql.begin((tx) => fn(tx))) as T;
        } catch (error) {
          if (
            this.dialect !== "sqlite" ||
            attempt >= 50 ||
            !/within a transaction/i.test(String((error as Error)?.message ?? error))
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    };
    if (this.dialect !== "sqlite") return run();
    const result = this.sqliteTail.then(run, run);
    this.sqliteTail = result.catch(() => {});
    return result;
  }

  /** The database's clock now, as a number, for values computed here. */
  private async clock(q: SQL): Promise<number> {
    const [row] = (await q`SELECT ${this.now(q)} AS now`) as Array<{ now: unknown }>;
    return Number(row!.now);
  }

  /** An epoch-milliseconds value or `NULL`, typed as the BIGINT columns are. */
  private timeOrNull(q: SQL, value: number | null) {
    return value === null ? q`NULL` : this.ms(q, value);
  }

  /** A 0..1 progress value as a parameter Postgres can assign to its column. */
  private fraction(q: SQL, value: number) {
    return this.dialect === "postgres" ? q`CAST(${value} AS DOUBLE PRECISION)` : q`${value}`;
  }

  /**
   * Postgres and SQLite: one statement. Postgres locks the rows it picks with
   * `SKIP LOCKED` in a CTE, which it evaluates once, so a concurrent claimer
   * skips them rather than waiting and then taking them too. SQLite serialises
   * writes, so its statement needs no lock clause to be atomic.
   */
  private async claimUpdating(limit: number, options: ClaimOptions): Promise<Row[]> {
    const q = this.sql;
    const now = this.now(q);
    const lease = this.ms(q, options.visibilityTimeoutMs);
    const table = this.name(q);

    if (this.dialect === "postgres") {
      return await q`
        WITH next AS (
          SELECT id FROM ${table}
          WHERE ${this.claimable(q, options)}
          ORDER BY available_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${table} AS job
        SET status = 'claimed', attempts = job.attempts + 1, claimed_at = ${now},
            lease_expires_at = ${now} + ${lease}, updated_at = ${now}
        FROM next
        WHERE job.id = next.id
        RETURNING job.*
      `;
    }

    return await q`
      UPDATE ${table}
      SET status = 'claimed', attempts = attempts + 1, claimed_at = ${now},
          lease_expires_at = ${now} + ${lease}, updated_at = ${now}
      WHERE id IN (
        SELECT id FROM ${table}
        WHERE ${this.claimable(q, options)}
        ORDER BY available_at, id
        LIMIT ${limit}
      )
      RETURNING *
    `;
  }

  /**
   * MySQL and MariaDB: lock, then update. The rows stay locked until the
   * transaction commits, so the attempt counted here is the one written.
   *
   * Two selects rather than one, because the `OR` in `claimable` leaves MySQL
   * no index to walk: it scans the whole table and sorts it (`type: ALL`,
   * `Using filesort`), and `LIMIT` is applied only after the sort, so InnoDB
   * locks every candidate row rather than the handful being claimed. A second
   * claimer's `SKIP LOCKED` then skips the entire table and claims nothing —
   * the opposite of what `SKIP LOCKED` is here for, and enough to serialise
   * every replica onto one claimer. Fixing `status` to a single value in each
   * pass lets its index supply both the filter and the order, so only the rows
   * actually handed out are locked. The two passes cannot overlap, because a
   * row's `status` is in exactly one of them.
   */
  private async claimLocking(limit: number, options: ClaimOptions): Promise<Row[]> {
    // A connection of our own, so the isolation level below is this claim's
    // and not the pool's. MySQL will not change it inside an open
    // transaction, and `begin` opens one at once, so it is set just before.
    const connection = await this.sql.reserve();
    const [isolation] = (await connection`
      SELECT @@transaction_isolation AS level
    `) as Array<{ level: string }>;
    // REPEATABLE READ — MySQL's default — locks the gaps a range scan passes
    // over, not just the rows it returns. The two passes below read different
    // indexes, so two claimers take those gap locks in opposite orders and
    // deadlock, even when the second pass matches no row at all. READ
    // COMMITTED takes no gap locks, which is what `SKIP LOCKED` wants: each
    // claimer locks the rows it is taking and nothing else.
    await connection`SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`;
    try {
      return await this.claimLockingOn(connection, limit, options);
    } finally {
      // The connection goes back to the pool the application shares, so it
      // goes back as it came. `@@transaction_isolation` reads back with a
      // hyphen and `SET` wants a space.
      const previous = isolation?.level?.replaceAll("-", " ");
      if (previous && /^[A-Z ]+$/.test(previous)) {
        await connection.unsafe(`SET SESSION TRANSACTION ISOLATION LEVEL ${previous}`);
      }
      connection.release();
    }
  }

  private async claimLockingOn(
    connection: SQL,
    limit: number,
    options: ClaimOptions,
  ): Promise<Row[]> {
    return await connection.begin(async (tx) => {
      const table = this.name(tx);
      const columns = tx.unsafe("*");

      // Waiting and due, oldest first, along the (status, available_at) index.
      const rows: Row[] = await tx`
        SELECT ${columns} FROM ${table}
        WHERE status = 'pending' AND available_at <= ${this.now(tx)}
          AND ${this.runnable(tx, options, "available_at")}
        ORDER BY available_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;

      // Only then the leases that ran out, longest-expired first, along the
      // (status, lease_expires_at) index. `claim` sorts what both passes
      // return by `available_at` before handing it to the manager.
      if (rows.length < limit) {
        const expired: Row[] = await tx`
          SELECT ${columns} FROM ${table}
          WHERE status = 'claimed' AND lease_expires_at <= ${this.now(tx)}
            AND ${this.runnable(tx, options, "lease_expires_at")}
          ORDER BY lease_expires_at, id
          LIMIT ${limit - rows.length}
          FOR UPDATE SKIP LOCKED
        `;
        rows.push(...expired);
      }

      for (const row of rows) {
        const now = this.now(tx);
        await tx`
          UPDATE ${table}
          SET status = 'claimed', attempts = attempts + 1, claimed_at = ${now},
              lease_expires_at = ${now} + ${this.ms(tx, options.visibilityTimeoutMs)},
              updated_at = ${now}
          WHERE id = ${row.id}
        `;
      }
      return rows.map((row) => ({ ...row, attempts: Number(row.attempts) + 1 }));
    });
  }

  /**
   * Waiting and due, or leased and the lease has run out — and, when the
   * claimer said which names it can run, under one of them or claimable for
   * longer than the grace window. See `ClaimOptions.registered`.
   */
  private claimable(q: SQL, options: ClaimOptions) {
    const now = this.now(q);
    return q`(
      (status = 'pending' AND available_at <= ${now}
        AND ${this.runnable(q, options, "available_at")})
      OR (status = 'claimed' AND lease_expires_at <= ${now}
        AND ${this.runnable(q, options, "lease_expires_at")})
    )`;
  }

  /**
   * Whether a row is one the claimer may take by its name. `since` is the
   * column holding when the row became claimable, which is what the grace
   * window is measured from: a job delayed for a day and due a second ago has
   * been waiting for a second, not a day, and a replica that knows its name
   * may be about to take it.
   *
   * The list is spliced in as one parameter per name, because `name IN ()` is
   * a syntax error in all three dialects; an empty registry matches no name
   * and leaves only the grace window.
   *
   * No index covers `name`, on purpose. On MySQL 8.4 the claim keeps walking
   * `(status, available_at)` and filters names as it goes, and a
   * `(status, name, available_at)` index is not chosen even when it exists:
   * it cannot hand back rows in `available_at` order across several names. A
   * head of rows with names this replica does not know costs only the scan,
   * not locks, because `claimLocking` claims at READ COMMITTED. Measured with
   * 2,000 unknown rows ahead of the rest: 10 record locks held for a claim of
   * 5, and a second replica that knows those names took them meanwhile. At
   * REPEATABLE READ the same claim held 4,014, and the second replica skipped
   * every one of them.
   */
  private runnable(q: SQL, options: ClaimOptions, since: "available_at" | "lease_expires_at") {
    const registered = options.registered;
    if (!registered) return q`1 = 1`;
    const names = registered.names.length
      ? q`name IN (${registered.names
          .map((name) => q`${name}`)
          .reduce((list, name) => q`${list}, ${name}`)})`
      : q`1 = 0`;
    if (!Number.isFinite(registered.graceMs)) return names;
    const column = q.unsafe(since);
    return q`(${names} OR ${column} <= ${this.now(q)} - ${this.ms(q, registered.graceMs)})`;
  }

  /**
   * The table name, already checked to be a plain identifier, and quoted the
   * way `createTable` quotes it. Unquoted, Postgres folds `GemiJobs` to
   * `gemijobs` and misses the table `createTable` (or a Prisma model without
   * `@@map`) made, and a reserved word such as `order` is a syntax error.
   */
  private name(q: SQL) {
    return q.unsafe(this.quoted(this.table));
  }

  /** The batches table, quoted as `name` quotes the jobs table. */
  private batches(q: SQL) {
    return q.unsafe(this.quoted(this.batchTable));
  }

  private quoted(table: string) {
    const mysql = this.dialect === "mysql" || this.dialect === "mariadb";
    return mysql ? `\`${table}\`` : `"${table}"`;
  }

  /** The database's clock, in epoch milliseconds. */
  private now(q: SQL) {
    switch (this.dialect) {
      case "postgres":
        return q`floor(extract(epoch from statement_timestamp()) * 1000)::bigint`;
      case "mysql":
      case "mariadb":
        // UTC against a naive epoch literal, so the session's time zone — and a
        // daylight-saving hour that occurs twice in it — never enters in.
        return q`(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6)) DIV 1000)`;
      case "sqlite":
        return q`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
    }
  }

  /**
   * A millisecond count as an integer parameter. Cast, so Postgres does not
   * have to infer the type of a bare parameter added to a `bigint`.
   */
  private ms(q: SQL, value: number) {
    const ms = Math.max(0, Math.round(value));
    return this.dialect === "mysql" || this.dialect === "mariadb"
      ? q`CAST(${ms} AS SIGNED)`
      : q`CAST(${ms} AS BIGINT)`;
  }
}

/**
 * How many rows a `DELETE` or `UPDATE` touched. SQLite and Postgres report
 * them in `count`; MySQL may report them in `affectedRows` and zero rows
 * returned in `count`.
 */
function affected(result: unknown): number {
  const counts = result as { count?: number | null; affectedRows?: number | null };
  return Math.max(Number(counts.count ?? 0), Number(counts.affectedRows ?? 0));
}

/**
 * The jobs table, as Prisma generates it for the model in the docs — checked
 * against `prisma migrate diff` for all three providers — with `IF NOT EXISTS`
 * added. MySQL cannot say that of an index, so its indexes are declared inside
 * the table, which is also where Prisma puts them.
 */
export function createTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`name\` VARCHAR(191) NOT NULL,
    \`payload\` LONGTEXT NOT NULL,
    \`status\` VARCHAR(191) NOT NULL,
    \`attempts\` INTEGER NOT NULL DEFAULT 0,
    \`available_at\` BIGINT NOT NULL,
    \`claimed_at\` BIGINT NULL,
    \`lease_expires_at\` BIGINT NULL,
    \`last_error\` LONGTEXT NULL,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,
    \`batch_id\` VARCHAR(191) NULL,
    \`progress\` DOUBLE NULL,

    INDEX \`${table}_status_available_at_idx\`(\`status\`, \`available_at\`),
    INDEX \`${table}_status_lease_expires_at_idx\`(\`status\`, \`lease_expires_at\`),
    INDEX \`${table}_batch_id_idx\`(\`batch_id\`),
    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ];
  }

  const key = dialect === "sqlite" ? `"id" TEXT NOT NULL PRIMARY KEY,` : `"id" TEXT NOT NULL,`;
  const constraint =
    dialect === "sqlite" ? "" : `,\n\n    CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")`;
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (
    ${key}
    "name" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" BIGINT NOT NULL,
    "claimed_at" BIGINT,
    "lease_expires_at" BIGINT,
    "last_error" TEXT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "batch_id" TEXT,
    "progress" ${dialect === "sqlite" ? "REAL" : "DOUBLE PRECISION"}${constraint}
)`,
    `CREATE INDEX IF NOT EXISTS "${table}_status_available_at_idx" ON "${table}"("status", "available_at")`,
    `CREATE INDEX IF NOT EXISTS "${table}_status_lease_expires_at_idx" ON "${table}"("status", "lease_expires_at")`,
    `CREATE INDEX IF NOT EXISTS "${table}_batch_id_idx" ON "${table}"("batch_id")`,
  ];
}

/**
 * The two columns and the index batches add to a jobs table made before them,
 * as Prisma's migration for the updated model writes them. `createTable` runs
 * these when the columns are missing; an app on Prisma gets the same from
 * `prisma migrate dev` after updating the model.
 */
export function addBatchColumnsStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `ALTER TABLE \`${table}\` ADD COLUMN \`batch_id\` VARCHAR(191) NULL,
    ADD COLUMN \`progress\` DOUBLE NULL,
    ADD INDEX \`${table}_batch_id_idx\`(\`batch_id\`)`,
    ];
  }
  const progress = dialect === "sqlite" ? "REAL" : "DOUBLE PRECISION";
  if (dialect === "sqlite") {
    return [
      `ALTER TABLE "${table}" ADD COLUMN "batch_id" TEXT`,
      `ALTER TABLE "${table}" ADD COLUMN "progress" ${progress}`,
      `CREATE INDEX IF NOT EXISTS "${table}_batch_id_idx" ON "${table}"("batch_id")`,
    ];
  }
  return [
    `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "batch_id" TEXT,
ADD COLUMN IF NOT EXISTS "progress" ${progress}`,
    `CREATE INDEX IF NOT EXISTS "${table}_batch_id_idx" ON "${table}"("batch_id")`,
  ];
}

/**
 * The batches table, as Prisma generates it for the `GemiJobBatch` model in
 * the docs, with `IF NOT EXISTS` added.
 */
export function createBatchTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`name\` VARCHAR(191) NULL,
    \`total\` INTEGER NOT NULL,
    \`pending\` INTEGER NOT NULL,
    \`succeeded\` INTEGER NOT NULL DEFAULT 0,
    \`failed\` INTEGER NOT NULL DEFAULT 0,
    \`cancelled\` INTEGER NOT NULL DEFAULT 0,
    \`failed_job_ids\` LONGTEXT NOT NULL,
    \`options\` LONGTEXT NOT NULL,
    \`cancelled_at\` BIGINT NULL,
    \`finished_at\` BIGINT NULL,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,

    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ];
  }

  const key = dialect === "sqlite" ? `"id" TEXT NOT NULL PRIMARY KEY,` : `"id" TEXT NOT NULL,`;
  const constraint =
    dialect === "sqlite" ? "" : `,\n\n    CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")`;
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (
    ${key}
    "name" TEXT,
    "total" INTEGER NOT NULL,
    "pending" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "failed_job_ids" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "cancelled_at" BIGINT,
    "finished_at" BIGINT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL${constraint}
)`,
  ];
}

/** A batch row as the record `batch.ts` works on. */
function batchRecord(row: BatchRow): BatchRecord {
  const options = JSON.parse(row.options) as {
    allowFailures?: boolean;
    callbacks?: BatchCallbacks;
  };
  const time = (value: BatchRow["cancelled_at"]) => (value == null ? null : Number(value));
  return {
    id: String(row.id),
    name: row.name == null ? null : String(row.name),
    total: Number(row.total),
    pending: Number(row.pending),
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    cancelled: Number(row.cancelled),
    failedJobIds: JSON.parse(row.failed_job_ids) as string[],
    cancelledAt: time(row.cancelled_at),
    finishedAt: time(row.finished_at),
    createdAt: Number(row.created_at),
    allowFailures: options.allowFailures === true,
    callbacks: options.callbacks ?? {},
  };
}

/** What the `options` column holds: what does not change once dispatched. */
function batchOptions(record: BatchRecord): string {
  return JSON.stringify({ allowFailures: record.allowFailures, callbacks: record.callbacks });
}

/**
 * Whether a database error says a table or column does not exist, in the
 * words of any of the three: Postgres' `relation … does not exist` and
 * `column … does not exist`, MySQL's `Table … doesn't exist` and `Unknown
 * column`, SQLite's `no such table` and `no such column`.
 */
function isMissingSchema(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /does not exist|doesn't exist|unknown column|no such (table|column)|has no column/i.test(
    message,
  );
}

/**
 * Runs a statement that needs the batch schema, and turns "no such table or
 * column" into an error that says what to do about it.
 */
async function explainMissingSchema<T>(statement: PromiseLike<T>, table: string): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    throw new Error(
      `Job batches need the "${table}" table and the batch_id and progress columns ` +
        `of the jobs table, and the database says one is missing. Add the ` +
        `GemiJobBatch model and the two GemiJob fields from the docs ` +
        `(docs/jobs-and-queues.md#batches) and migrate, or call the driver's ` +
        `createTable().`,
      { cause: error },
    );
  }
}
