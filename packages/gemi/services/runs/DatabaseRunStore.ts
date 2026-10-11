import type { SQL, TransactionSQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { currentConnectionName, currentTransaction } from "../../orm/context";
import {
  FINAL_RUN_STATUSES,
  isFinalRunStatus,
  listLimit,
  type NewRunRecord,
  OPEN_RUN_STATUSES,
  type RunError,
  type RunFilter,
  type RunProgress,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type RunUpdate,
} from "./RunStore";

export type DatabaseRunStoreOptions = {
  /**
   * The table. Default `gemi_runs`. A plain identifier (letters, digits and
   * underscores), because it is spliced into every statement.
   */
  table?: string;
};

type Row = Record<string, unknown>;

type Connection = Pick<DatabaseConnection, "sql" | "dialect"> &
  Partial<Pick<DatabaseConnection, "name">>;

/**
 * Runs (#908) in a table of the app's own database, so a run outlives the
 * process that started it and every instance sees the same state.
 *
 * Written for SQLite, Postgres and MySQL 8 / MariaDB 10.6+ in raw SQL. The
 * table is the app's to create: add the Prisma model from the docs, or call
 * `createTable()`.
 *
 * - **Compare-and-set** is `UPDATE … WHERE id = ? AND status IN (…)`, so two
 *   instances settling one run cannot both win.
 * - **Time** is epoch milliseconds from the database's clock, so every
 *   instance agrees on when a run is overdue.
 * - **Transactions.** Inside an ORM transaction on this store's connection,
 *   the store writes on it, so `Runs.create` and a database-queue
 *   `Job.dispatch` in one transaction commit together, or not at all.
 */
export class DatabaseRunStore implements RunStore {
  readonly table: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  private readonly connection: string | undefined;

  constructor(connection: Connection, options: DatabaseRunStoreOptions = {}) {
    const table = options.table ?? "gemi_runs";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(
        `The runs table name "${table}" is not a plain identifier. Use letters, digits and underscores.`,
      );
    }
    this.table = table;
    this.sql = connection.sql;
    this.dialect = connection.dialect;
    this.connection = connection.name;
  }

  /**
   * Creates the table and its indexes if they do not exist: the DDL Prisma
   * generates for the model in the docs. For tests and for an app that does
   * not manage its schema with Prisma.
   */
  async createTable(): Promise<void> {
    for (const statement of createRunsTableStatements(this.dialect, this.table)) {
      await this.sql.unsafe(statement);
    }
  }

  async create(run: NewRunRecord): Promise<RunRecord> {
    const q = this.q();
    const now = this.clock(q);
    const deadline = run.deadlineMs === null ? q`NULL` : q`${now} + ${this.ms(q, run.deadlineMs)}`;
    const started = run.status === "running" ? now : q`NULL`;
    await q`
      INSERT INTO ${this.name(q)}
        (id, kind, subject, owner, status, meta, version,
         created_at, started_at, updated_at, deadline_at)
      VALUES
        (${run.id}, ${run.kind}, ${run.subject}, ${run.owner}, ${run.status},
         ${json(run.meta)}, 1, ${now}, ${started}, ${now}, ${deadline})
    `;
    const record = await this.get(run.id);
    if (!record) throw new Error(`The run ${run.id} was not found after it was written.`);
    return record;
  }

  async get(id: string): Promise<RunRecord | null> {
    const q = this.q();
    const rows: Row[] = await q`SELECT * FROM ${this.name(q)} WHERE id = ${id}`;
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async list(filter: RunFilter): Promise<RunRecord[]> {
    const q = this.q();
    const where = [q`1 = 1`];
    if (filter.kind !== undefined) where.push(q`kind = ${filter.kind}`);
    if (filter.subject !== undefined) where.push(q`subject = ${filter.subject}`);
    if (filter.owner !== undefined) where.push(q`owner = ${filter.owner}`);
    if (filter.statuses !== undefined) {
      where.push(
        filter.statuses.length === 0 ? q`1 = 0` : q`status IN (${list(q, filter.statuses)})`,
      );
    }
    const condition = where.reduce((all, one) => q`${all} AND ${one}`);
    const rows: Row[] = await q`
      SELECT * FROM ${this.name(q)}
      WHERE ${condition}
      ORDER BY created_at DESC, id DESC
      LIMIT ${listLimit(filter.limit)}
    `;
    return rows.map(recordOf);
  }

  async transition(
    id: string,
    from: readonly RunStatus[],
    to: RunUpdate,
  ): Promise<RunRecord | null> {
    if (from.length === 0) return null;
    const q = this.q();
    const now = this.clock(q);
    const sets = [q`updated_at = ${now}`, q`version = version + 1`];
    if (to.status !== undefined) {
      sets.push(q`status = ${to.status}`);
      if (to.status !== "pending") sets.push(q`started_at = COALESCE(started_at, ${now})`);
      if (isFinalRunStatus(to.status)) sets.push(q`finished_at = ${now}`);
    }
    if ("progress" in to) sets.push(q`progress = ${json(to.progress)}`);
    if ("result" in to) sets.push(q`result = ${json(to.result)}`);
    if ("error" in to) sets.push(q`error = ${json(to.error)}`);
    const set = sets.reduce((all, one) => q`${all}, ${one}`);
    const result = await q`
      UPDATE ${this.name(q)} SET ${set}
      WHERE id = ${id} AND status IN (${list(q, from)})
    `;
    if (affected(result) === 0) return null;
    return this.get(id);
  }

  async overdue(now: number, limit: number): Promise<RunRecord[]> {
    const q = this.q();
    const rows: Row[] = await q`
      SELECT * FROM ${this.name(q)}
      WHERE status IN (${list(q, OPEN_RUN_STATUSES)})
        AND deadline_at IS NOT NULL AND deadline_at <= ${this.ms(q, now)}
      ORDER BY deadline_at, id
      LIMIT ${Math.max(0, Math.floor(limit))}
    `;
    return rows.map(recordOf);
  }

  async now(): Promise<number> {
    const q = this.q();
    const [row] = (await q`SELECT ${this.clock(q)} AS now`) as Array<{ now: unknown }>;
    return Number(row!.now);
  }

  async prune(olderThanMs: number): Promise<number> {
    const q = this.q();
    const result = await q`
      DELETE FROM ${this.name(q)}
      WHERE status IN (${list(q, FINAL_RUN_STATUSES)})
        AND finished_at <= ${this.clock(q)} - ${this.ms(q, olderThanMs)}
    `;
    return affected(result);
  }

  /** The open ORM transaction, when it is on this store's connection. */
  private joinable(): TransactionSQL | undefined {
    if (this.connection === undefined) return undefined;
    const tx = currentTransaction();
    if (tx === undefined || currentConnectionName() !== this.connection) return undefined;
    return tx;
  }

  /** Read at each call and never kept: a stored transaction handle outlives its transaction. */
  private q(): SQL {
    return (this.joinable() as SQL | undefined) ?? this.sql;
  }

  private name(q: SQL) {
    const mysql = this.dialect === "mysql" || this.dialect === "mariadb";
    return q.unsafe(mysql ? `\`${this.table}\`` : `"${this.table}"`);
  }

  /** The database's clock, in epoch milliseconds. As in `DatabaseQueueDriver`. */
  private clock(q: SQL) {
    switch (this.dialect) {
      case "postgres":
        return q`floor(extract(epoch from statement_timestamp()) * 1000)::bigint`;
      case "mysql":
      case "mariadb":
        return q`(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6)) DIV 1000)`;
      case "sqlite":
        return q`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
    }
  }

  private ms(q: SQL, value: number) {
    const ms = Math.max(0, Math.round(value));
    return this.dialect === "mysql" || this.dialect === "mariadb"
      ? q`CAST(${ms} AS SIGNED)`
      : q`CAST(${ms} AS BIGINT)`;
  }
}

function list(q: SQL, values: readonly string[]) {
  return values.map((value) => q`${value}`).reduce((all, one) => q`${all}, ${one}`);
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parse(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return JSON.parse(String(value));
}

function timeOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function recordOf(row: Row): RunRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    subject: stringOrNull(row.subject),
    owner: stringOrNull(row.owner),
    status: String(row.status) as RunStatus,
    meta: parse(row.meta),
    progress: parse(row.progress) as RunProgress | null,
    result: parse(row.result),
    error: parse(row.error) as RunError | null,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    startedAt: timeOrNull(row.started_at),
    updatedAt: Number(row.updated_at),
    finishedAt: timeOrNull(row.finished_at),
    deadlineAt: timeOrNull(row.deadline_at),
  };
}

/** Rows a `DELETE` or `UPDATE` touched, across the three drivers. */
function affected(result: unknown): number {
  const counts = result as { count?: number | null; affectedRows?: number | null };
  return Math.max(Number(counts.count ?? 0), Number(counts.affectedRows ?? 0));
}

/**
 * The table as Prisma generates it for the model in the docs, with
 * `IF NOT EXISTS` added.
 */
export function createRunsTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`kind\` VARCHAR(191) NOT NULL,
    \`subject\` VARCHAR(191) NULL,
    \`owner\` VARCHAR(191) NULL,
    \`status\` VARCHAR(191) NOT NULL,
    \`meta\` LONGTEXT NULL,
    \`progress\` LONGTEXT NULL,
    \`result\` LONGTEXT NULL,
    \`error\` LONGTEXT NULL,
    \`version\` INTEGER NOT NULL DEFAULT 1,
    \`created_at\` BIGINT NOT NULL,
    \`started_at\` BIGINT NULL,
    \`updated_at\` BIGINT NOT NULL,
    \`finished_at\` BIGINT NULL,
    \`deadline_at\` BIGINT NULL,

    INDEX \`${table}_subject_created_at_idx\`(\`subject\`, \`created_at\`),
    INDEX \`${table}_status_deadline_at_idx\`(\`status\`, \`deadline_at\`),
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
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "owner" TEXT,
    "status" TEXT NOT NULL,
    "meta" TEXT,
    "progress" TEXT,
    "result" TEXT,
    "error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" BIGINT NOT NULL,
    "started_at" BIGINT,
    "updated_at" BIGINT NOT NULL,
    "finished_at" BIGINT,
    "deadline_at" BIGINT${constraint}
)`,
    `CREATE INDEX IF NOT EXISTS "${table}_subject_created_at_idx" ON "${table}"("subject", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "${table}_status_deadline_at_idx" ON "${table}"("status", "deadline_at")`,
  ];
}
