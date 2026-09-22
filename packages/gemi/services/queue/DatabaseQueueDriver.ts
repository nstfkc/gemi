import type { SQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import type { ClaimOptions, ClaimedJob, EnqueueJob, JobFailure, QueueDriver } from "./QueueDriver";

export type DatabaseQueueDriverOptions = {
  /**
   * The jobs table. Default `gemi_jobs`. A plain identifier — letters, digits
   * and underscores — because it is spliced into every statement.
   */
  table?: string;
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
 * UPDATE SKIP LOCKED` and one `UPDATE` per row in a transaction. SQLite has
 * no row locks and needs none: it runs one write at a time, so a single
 * `UPDATE … RETURNING` is atomic. MariaDB needs 10.6 for `SKIP LOCKED`.
 *
 * ### Time
 *
 * Every time in the table is epoch milliseconds, read from the database's
 * clock rather than this process's, so replicas with skewed clocks still agree
 * on when a lease ran out. Integers rather than timestamp columns so the same
 * arithmetic works in all three dialects.
 *
 * ### What it does not do
 *
 * It has no `subscribe`: another process's dispatch cannot wake this one, so
 * the queue polls every `pollInterval` (and wakes itself for its own
 * dispatches). A dispatch inside an open ORM transaction is not part of it —
 * the row is written on the pool and stays if the transaction rolls back, and
 * the job can run before the transaction commits. Dispatch after the commit.
 */
export class DatabaseQueueDriver implements QueueDriver {
  readonly table: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect">,
    options: DatabaseQueueDriverOptions = {},
  ) {
    const table = options.table ?? "gemi_jobs";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(
        `The queue table name "${table}" is not a plain identifier. Use ` +
          `letters, digits and underscores.`,
      );
    }
    this.table = table;
    this.sql = connection.sql;
    this.dialect = connection.dialect;
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
    for (const statement of createTableStatements(this.dialect, this.table)) {
      await this.sql.unsafe(statement);
    }
  }

  async enqueue({ name, args, delayMs = 0 }: EnqueueJob): Promise<string> {
    const q = this.sql;
    const id = Bun.randomUUIDv7();
    const now = this.now(q);
    await q`
      INSERT INTO ${this.name(q)}
        (id, name, payload, status, attempts, available_at, created_at, updated_at)
      VALUES
        (${id}, ${name}, ${args}, 'pending', 0, ${now} + ${this.ms(q, delayMs)}, ${now}, ${now})
    `;
    return id;
  }

  async claim(limit: number, options: ClaimOptions): Promise<ClaimedJob[]> {
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];

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
    const q = this.sql;
    await q`
      DELETE FROM ${this.name(q)}
      WHERE id = ${job.id} AND status = 'claimed' AND attempts = ${job.attempt}
    `;
  }

  async fail(job: ClaimedJob, failure: JobFailure): Promise<void> {
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
   * Extends a lease that has lapsed but not been re-issued, too, as the memory
   * driver does: the job is still running here and nobody else has it.
   */
  async heartbeat(jobs: ClaimedJob[], options: ClaimOptions): Promise<void> {
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
          WHERE ${this.claimable(q)}
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
        WHERE ${this.claimable(q)}
        ORDER BY available_at, id
        LIMIT ${limit}
      )
      RETURNING id, name, payload, attempts, available_at, created_at
    `;
  }

  /**
   * MySQL and MariaDB: lock, then update. The rows stay locked until the
   * transaction commits, so the attempt counted here is the one written.
   */
  private async claimLocking(limit: number, options: ClaimOptions): Promise<Row[]> {
    return await this.sql.begin(async (tx) => {
      const table = this.name(tx);
      const rows: Row[] = await tx`
        SELECT id, name, payload, attempts, available_at, created_at FROM ${table}
        WHERE ${this.claimable(tx)}
        ORDER BY available_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
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

  /** Waiting and due, or leased and the lease has run out. */
  private claimable(q: SQL) {
    const now = this.now(q);
    return q`(
      (status = 'pending' AND available_at <= ${now})
      OR (status = 'claimed' AND lease_expires_at <= ${now})
    )`;
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
