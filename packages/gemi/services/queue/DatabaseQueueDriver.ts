import type { SQL, TransactionSQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { commitDependsOn, currentConnectionName, currentTransaction } from "../../orm/context";
import type {
  ClaimOptions,
  ClaimedJob,
  EnqueueJob,
  JobFailure,
  JobRelease,
  QueueDriver,
} from "./QueueDriver";

export type DatabaseQueueDriverOptions = {
  /**
   * The jobs table. Default `gemi_jobs`. A plain identifier — letters, digits
   * and underscores — because it is spliced into every statement.
   */
  table?: string;
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
};

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
 * ### What it does not do
 *
 * It has no `subscribe`: another process's dispatch cannot wake this one, so
 * the queue polls every `pollInterval` (and wakes itself for its own
 * dispatches).
 */
export class DatabaseQueueDriver implements QueueDriver {
  readonly table: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  /** The connection's name, when it came with one; see `transaction`. */
  private readonly connection: string | undefined;
  private readonly busyTimeout: number;
  private configured: Promise<void> | undefined;

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect"> &
      Partial<Pick<DatabaseConnection, "name">>,
    options: DatabaseQueueDriverOptions = {},
  ) {
    const table = options.table ?? "gemi_jobs";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(
        `The queue table name "${table}" is not a plain identifier. Use ` +
          `letters, digits and underscores.`,
      );
    }
    const busyTimeout = options.busyTimeout ?? 1000;
    if (!Number.isInteger(busyTimeout) || busyTimeout < 0) {
      throw new Error(
        `The queue's busyTimeout must be a whole number of milliseconds, 0 or more; got ${busyTimeout}.`,
      );
    }
    this.table = table;
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
   * Creates the table and its indexes if they do not exist — the same DDL
   * Prisma generates for the model in the docs, so a table made either way is
   * the table the other expects. For tests and for an app that does not
   * manage its schema with Prisma; one that does should add the model
   * instead, or `prisma migrate` will see a table it does not know and drop
   * it.
   */
  async createTable(): Promise<void> {
    await this.configure();
    for (const statement of createTableStatements(this.dialect, this.table)) {
      await this.sql.unsafe(statement);
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
    return rows
      .map((row) => ({
        order: Number(row.available_at),
        job: {
          id: String(row.id),
          name: String(row.name),
          args: String(row.payload),
          attempt: Number(row.attempts),
          createdAt: Number(row.created_at),
        },
      }))
      .sort((a, b) => a.order - b.order || (a.job.id < b.job.id ? -1 : 1))
      .map(({ job }) => job);
  }

  async complete(job: ClaimedJob): Promise<void> {
    await this.configure();
    const q = this.sql;
    await q`
      DELETE FROM ${this.name(q)}
      WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
    `;
  }

  async fail(job: ClaimedJob, failure: JobFailure): Promise<void> {
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
   * Deletes dead-lettered jobs last touched more than `olderThanMs` ago, and
   * resolves to how many. Dead rows are kept so a failure can be read and the
   * job re-queued by hand; nothing removes them unless this is called — from
   * a scheduled job, say.
   */
  async prune(olderThanMs: number): Promise<number> {
    await this.configure();
    const q = this.sql;
    const result = await q`
      DELETE FROM ${this.name(q)}
      WHERE status = 'dead' AND updated_at <= ${this.now(q)} - ${this.ms(q, olderThanMs)}
    `;
    // SQLite and Postgres report deleted rows in `count`; MySQL may report
    // them in `affectedRows` and zero rows returned in `count`.
    const counts = result as unknown as { count?: number | null; affectedRows?: number | null };
    return Math.max(Number(counts.count ?? 0), Number(counts.affectedRows ?? 0));
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
        RETURNING job.id, job.name, job.payload, job.attempts, job.available_at, job.created_at
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
      RETURNING id, name, payload, attempts, available_at, created_at
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
      const columns = tx.unsafe("id, name, payload, attempts, available_at, created_at");

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
    const mysql = this.dialect === "mysql" || this.dialect === "mariadb";
    return q.unsafe(mysql ? `\`${this.table}\`` : `"${this.table}"`);
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

    INDEX \`${table}_status_available_at_idx\`(\`status\`, \`available_at\`),
    INDEX \`${table}_status_lease_expires_at_idx\`(\`status\`, \`lease_expires_at\`),
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
    "updated_at" BIGINT NOT NULL${constraint}
)`,
    `CREATE INDEX IF NOT EXISTS "${table}_status_available_at_idx" ON "${table}"("status", "available_at")`,
    `CREATE INDEX IF NOT EXISTS "${table}_status_lease_expires_at_idx" ON "${table}"("status", "lease_expires_at")`,
  ];
}
