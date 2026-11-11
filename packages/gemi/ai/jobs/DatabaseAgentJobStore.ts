import type { SQL, TransactionSQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { currentConnectionName, currentTransaction, withTransaction } from "../../orm/context";
import {
  type AgentJobRecord,
  type AgentJobState,
  type AgentJobStore,
  type AgentJobUpdate,
  isSettled,
  type NewAgentJobRecord,
} from "./AgentJobStore";

/**
 * The columns added for `after`, batches, the inbox and checkpoints (#1222).
 * A table made before them still works for everything else; see `columns()`.
 */
const LATER_COLUMNS = ["after_jobs", "batch_key", "queued", "inbox", "job_checkpoint"] as const;

/** How many times an inbox write retries a compare-and-set it lost to another writer. */
const INBOX_ATTEMPTS = 20;

export type DatabaseAgentJobStoreOptions = {
  /**
   * The table. Default `gemi_agent_jobs`. A plain identifier (letters, digits
   * and underscores), because it is spliced into every statement.
   */
  table?: string;
};

type Row = Record<string, unknown>;

/**
 * Background jobs (#461) in a table of the app's own database, so a job and
 * its outcome outlive the process: a deploy in the middle of a render no
 * longer loses it, and every instance sees the same state.
 *
 * Opt in, like the agent store:
 *
 *     AgentJobs.use(new DatabaseAgentJobStore(app(DatabaseManager).connection()));
 *
 * Written for SQLite, Postgres and MySQL 8 / MariaDB 10.6+ in raw SQL, as the
 * database queue driver is, and the table is the app's to create: add the
 * Prisma model from the docs, or call `createTable()`.
 *
 * - **Compare-and-set** is `UPDATE … WHERE id = ? AND state IN (…)`, so two
 *   instances settling one job cannot both win.
 * - **Time** is epoch milliseconds read from the database's clock, so the
 *   deadline sweep on any instance agrees on when a job is overdue.
 * - **Transactions.** `ctx.jobs.start` writes the record and queues the job
 *   inside `transaction()`. On Postgres and MySQL, with the database queue
 *   driver on the same connection, both rows commit together or not at all.
 *   With any other queue the dispatch is held until the record has committed.
 */
export class DatabaseAgentJobStore implements AgentJobStore {
  readonly table: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  private readonly connection: string | undefined;
  /** Whether the table has `LATER_COLUMNS`, once asked. */
  private later: Promise<boolean> | undefined;

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect"> &
      Partial<Pick<DatabaseConnection, "name">>,
    options: DatabaseAgentJobStoreOptions = {},
  ) {
    const table = options.table ?? "gemi_agent_jobs";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(
        `The agent jobs table name "${table}" is not a plain identifier. Use letters, digits and underscores.`,
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
    for (const statement of createAgentJobsTableStatements(this.dialect, this.table)) {
      await this.sql.unsafe(statement);
    }
  }

  /**
   * Runs `fn` in a transaction on this store's connection, joining one that is
   * already open on it. `ctx.jobs.start` writes the record and queues the job
   * in here.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // A store built from a bare `{ sql, dialect }` has no connection name, so
    // it cannot tell its own transaction from another one, and runs without.
    if (this.connection === undefined || this.joinable()) return fn();
    return withTransaction(this.sql, () => fn(), { connection: this.connection });
  }

  async create(job: NewAgentJobRecord): Promise<AgentJobRecord> {
    const usesLater =
      job.after !== undefined || job.batch !== undefined || job.queued !== undefined;
    if (usesLater) await this.requireLaterColumns("A job with `after` or `batch`");
    const q = this.q();
    const now = this.clock(q);
    const state = job.state ?? "running";
    if (usesLater) {
      await q`
        INSERT INTO ${this.name(q)}
          (id, thread_id, run_id, tool_call_id, tool_name, owner, job, summary, state,
           orphaned, attachment_scope, created_at, updated_at, deadline_at,
           after_jobs, batch_key, queued)
        VALUES
          (${job.id}, ${job.threadId}, ${job.runId}, ${job.toolCallId}, ${job.toolName},
           ${job.owner}, ${job.job}, ${json(job.summary)}, ${state}, 0, ${job.attachmentScope},
           ${now}, ${now}, ${now} + ${this.ms(q, job.deadlineMs)},
           ${json(job.after)}, ${job.batch ?? null}, ${json(job.queued)})
      `;
    } else {
      await q`
        INSERT INTO ${this.name(q)}
          (id, thread_id, run_id, tool_call_id, tool_name, owner, job, summary, state,
           orphaned, attachment_scope, created_at, updated_at, deadline_at)
        VALUES
          (${job.id}, ${job.threadId}, ${job.runId}, ${job.toolCallId}, ${job.toolName},
           ${job.owner}, ${job.job}, ${json(job.summary)}, ${state}, 0, ${job.attachmentScope},
           ${now}, ${now}, ${now} + ${this.ms(q, job.deadlineMs)})
      `;
    }
    const record = await this.get(job.id);
    if (!record)
      throw new Error(`The background job ${job.id} was not found after it was written.`);
    return record;
  }

  async get(id: string): Promise<AgentJobRecord | null> {
    const q = this.q();
    const rows: Row[] = await q`SELECT * FROM ${this.name(q)} WHERE id = ${id}`;
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async listForThread(
    threadId: string,
    options: { states?: AgentJobState[]; limit?: number } = {},
  ): Promise<AgentJobRecord[]> {
    const q = this.q();
    const states =
      options.states === undefined
        ? q`1 = 1`
        : options.states.length === 0
          ? q`1 = 0`
          : q`state IN (${list(q, options.states)})`;
    const rows: Row[] =
      options.limit === undefined
        ? await q`
            SELECT * FROM ${this.name(q)}
            WHERE thread_id = ${threadId} AND ${states}
            ORDER BY created_at DESC, id DESC
          `
        : await q`
            SELECT * FROM ${this.name(q)}
            WHERE thread_id = ${threadId} AND ${states}
            ORDER BY created_at DESC, id DESC
            LIMIT ${Math.max(0, Math.floor(options.limit))}
          `;
    return rows.map(recordOf);
  }

  async transition(id: string, from: AgentJobState[], to: AgentJobUpdate): Promise<boolean> {
    if (from.length === 0) return false;
    if ("checkpoint" in to) await this.requireLaterColumns("`job.checkpoint`");
    const q = this.q();
    const now = this.clock(q);
    const sets = [q`updated_at = ${now}`];
    if (to.deadlineMs !== undefined) {
      sets.push(q`deadline_at = ${now} + ${this.ms(q, to.deadlineMs)}`);
    }
    if ("checkpoint" in to) sets.push(q`job_checkpoint = ${json(to.checkpoint)}`);
    if (to.state !== undefined) sets.push(q`state = ${to.state}`);
    if ("output" in to) sets.push(q`output = ${json(to.output)}`);
    if ("error" in to) sets.push(q`error = ${json(to.error)}`);
    // `usage` is a reserved word in MySQL.
    if ("usage" in to) sets.push(q`${this.column(q, "usage")} = ${json(to.usage)}`);
    if ("orphaned" in to) sets.push(q`orphaned = ${to.orphaned ? 1 : 0}`);
    if (to.state !== undefined && isSettled(to.state)) {
      sets.push(
        to.settledAt !== undefined
          ? q`settled_at = COALESCE(settled_at, ${this.ms(q, to.settledAt)})`
          : q`settled_at = COALESCE(settled_at, ${now})`,
      );
    }
    const set = sets.reduce((all, one) => q`${all}, ${one}`);
    const result = await q`
      UPDATE ${this.name(q)} SET ${set}
      WHERE id = ${id} AND state IN (${list(q, from)})
    `;
    return affected(result) > 0;
  }

  async overdue(now: number, limit: number): Promise<AgentJobRecord[]> {
    const q = this.q();
    const rows: Row[] = await q`
      SELECT * FROM ${this.name(q)}
      WHERE state = 'running' AND deadline_at <= ${this.ms(q, now)}
      ORDER BY deadline_at, id
      LIMIT ${Math.max(0, Math.floor(limit))}
    `;
    return rows.map(recordOf);
  }

  async waitingOn(id: string): Promise<AgentJobRecord[]> {
    // Asked after every settle: a table without the columns has no waiting jobs.
    if (!(await this.columns())) return [];
    const q = this.q();
    const rows: Row[] = await q`
      SELECT * FROM ${this.name(q)}
      WHERE state = 'waiting' AND after_jobs LIKE ${`%${JSON.stringify(id)}%`}
      ORDER BY created_at, id
    `;
    return rows.map(recordOf).filter((record) => record.after?.includes(id));
  }

  async waiting(limit: number): Promise<AgentJobRecord[]> {
    const q = this.q();
    const rows: Row[] = await q`
      SELECT * FROM ${this.name(q)}
      WHERE state = 'waiting'
      ORDER BY created_at, id
      LIMIT ${Math.max(0, Math.floor(limit))}
    `;
    return rows.map(recordOf);
  }

  async listBatch(batch: string): Promise<AgentJobRecord[]> {
    if (!(await this.columns())) return [];
    const q = this.q();
    const rows: Row[] = await q`
      SELECT * FROM ${this.name(q)} WHERE batch_key = ${batch} ORDER BY created_at, id
    `;
    return rows.map(recordOf);
  }

  /**
   * Compare-and-set on the inbox's text, so two senders (or a sender and the
   * job taking its messages) never lose one another's write.
   */
  async appendInbox(id: string, text: string): Promise<boolean> {
    await this.requireLaterColumns("`AgentJobs.message`");
    for (let attempt = 0; attempt < INBOX_ATTEMPTS; attempt++) {
      const q = this.q();
      const [row] = (await q`
        SELECT state, inbox FROM ${this.name(q)} WHERE id = ${id}
      `) as Row[];
      if (!row || isSettled(String(row.state) as AgentJobState)) return false;
      const before = row.inbox === null || row.inbox === undefined ? null : String(row.inbox);
      const after = JSON.stringify([...((parse(before) as string[] | undefined) ?? []), text]);
      const result = await q`
        UPDATE ${this.name(q)} SET inbox = ${after}, updated_at = ${this.clock(q)}
        WHERE id = ${id} AND state IN ('waiting', 'running') AND ${this.sameInbox(q, before)}
      `;
      if (affected(result) > 0) return true;
    }
    throw new Error(`Could not add a message to background job ${id}: too many writers at once.`);
  }

  async takeInbox(id: string): Promise<string[]> {
    if (!(await this.columns())) return [];
    for (let attempt = 0; attempt < INBOX_ATTEMPTS; attempt++) {
      const q = this.q();
      const [row] = (await q`SELECT inbox FROM ${this.name(q)} WHERE id = ${id}`) as Row[];
      if (!row || row.inbox === null || row.inbox === undefined) return [];
      const before = String(row.inbox);
      const result = await q`
        UPDATE ${this.name(q)} SET inbox = NULL WHERE id = ${id} AND ${this.sameInbox(q, before)}
      `;
      if (affected(result) > 0) return (parse(before) as string[] | undefined) ?? [];
    }
    throw new Error(`Could not take the messages of background job ${id}: too many writers.`);
  }

  async now(): Promise<number> {
    const q = this.q();
    const [row] = (await q`SELECT ${this.clock(q)} AS now`) as Array<{ now: unknown }>;
    return Number(row!.now);
  }

  /**
   * Deletes settled jobs that settled more than `olderThanMs` ago, and answers
   * how many. A settled result is written back into the thread on the next
   * turn, after which the record is only history; nothing removes it unless
   * this is called, from a cron job say. Running jobs are never pruned.
   */
  async prune(olderThanMs: number): Promise<number> {
    const q = this.q();
    const result = await q`
      DELETE FROM ${this.name(q)}
      WHERE state IN ('ok', 'error') AND settled_at <= ${this.clock(q)} - ${this.ms(q, olderThanMs)}
    `;
    return affected(result);
  }

  /**
   * Whether the table has the columns `after`, batches, the inbox and
   * checkpoints need (#1222). Asked once, outside any transaction (a failed
   * statement would abort a Postgres one), by selecting them from no rows.
   */
  columns(): Promise<boolean> {
    this.later ??= (async () => {
      try {
        await this.sql.unsafe(
          `SELECT ${LATER_COLUMNS.join(", ")} FROM ${this.quoted(this.table)} WHERE 1 = 0`,
        );
        return true;
      } catch {
        return false;
      }
    })();
    return this.later;
  }

  private async requireLaterColumns(what: string): Promise<void> {
    if (await this.columns()) return;
    // Asked again next time: the app may add them without a restart.
    this.later = undefined;
    throw new Error(
      `${what} needs the columns ${LATER_COLUMNS.join(", ")} on the ${this.table} table, which it does not have. Add them (see docs/ai-background-jobs.md and UPGRADE.md), or call createTable() on a new table.`,
    );
  }

  private sameInbox(q: SQL, before: string | null) {
    return before === null ? q`inbox IS NULL` : q`inbox = ${before}`;
  }

  private quoted(name: string): string {
    const mysql = this.dialect === "mysql" || this.dialect === "mariadb";
    return mysql ? `\`${name}\`` : `"${name}"`;
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

  private column(q: SQL, name: string) {
    const mysql = this.dialect === "mysql" || this.dialect === "mariadb";
    return q.unsafe(mysql ? `\`${name}\`` : `"${name}"`);
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

function list(q: SQL, values: string[]) {
  return values.map((value) => q`${value}`).reduce((all, one) => q`${all}, ${one}`);
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parse(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(String(value));
}

function recordOf(row: Row): AgentJobRecord {
  const summary = parse(row.summary);
  const output = parse(row.output);
  const error = parse(row.error);
  const usage = parse(row.usage);
  const after = parse(row.after_jobs);
  const queued = parse(row.queued);
  const inbox = parse(row.inbox);
  const checkpoint = parse(row.job_checkpoint);
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    runId: String(row.run_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    owner: row.owner === null || row.owner === undefined ? null : String(row.owner),
    job: row.job === null || row.job === undefined ? null : String(row.job),
    ...(summary !== undefined ? { summary } : {}),
    state: String(row.state) as AgentJobState,
    ...(output !== undefined ? { output } : {}),
    ...(error !== undefined ? { error: error as AgentJobRecord["error"] } : {}),
    ...(usage !== undefined ? { usage: usage as AgentJobRecord["usage"] } : {}),
    ...(Number(row.orphaned) === 1 ? { orphaned: true as const } : {}),
    attachmentScope:
      row.attachment_scope === null || row.attachment_scope === undefined
        ? null
        : String(row.attachment_scope),
    ...(after !== undefined ? { after: after as string[] } : {}),
    ...(row.batch_key === null || row.batch_key === undefined
      ? {}
      : { batch: String(row.batch_key) }),
    ...(queued !== undefined ? { queued: queued as AgentJobRecord["queued"] } : {}),
    ...(inbox !== undefined && (inbox as string[]).length > 0 ? { inbox: inbox as string[] } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deadlineAt: Number(row.deadline_at),
    ...(row.settled_at === null || row.settled_at === undefined
      ? {}
      : { settledAt: Number(row.settled_at) }),
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
export function createAgentJobsTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`thread_id\` VARCHAR(191) NOT NULL,
    \`run_id\` VARCHAR(191) NOT NULL,
    \`tool_call_id\` VARCHAR(191) NOT NULL,
    \`tool_name\` VARCHAR(191) NOT NULL,
    \`owner\` VARCHAR(191) NULL,
    \`job\` VARCHAR(191) NULL,
    \`summary\` LONGTEXT NULL,
    \`state\` VARCHAR(191) NOT NULL,
    \`output\` LONGTEXT NULL,
    \`error\` LONGTEXT NULL,
    \`usage\` LONGTEXT NULL,
    \`orphaned\` INTEGER NOT NULL DEFAULT 0,
    \`attachment_scope\` VARCHAR(191) NULL,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,
    \`deadline_at\` BIGINT NOT NULL,
    \`settled_at\` BIGINT NULL,
    \`after_jobs\` LONGTEXT NULL,
    \`batch_key\` VARCHAR(191) NULL,
    \`queued\` LONGTEXT NULL,
    \`inbox\` LONGTEXT NULL,
    \`job_checkpoint\` LONGTEXT NULL,

    INDEX \`${table}_thread_id_created_at_idx\`(\`thread_id\`, \`created_at\`),
    INDEX \`${table}_state_deadline_at_idx\`(\`state\`, \`deadline_at\`),
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
    "thread_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "tool_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "owner" TEXT,
    "job" TEXT,
    "summary" TEXT,
    "state" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "usage" TEXT,
    "orphaned" INTEGER NOT NULL DEFAULT 0,
    "attachment_scope" TEXT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "deadline_at" BIGINT NOT NULL,
    "settled_at" BIGINT,
    "after_jobs" TEXT,
    "batch_key" TEXT,
    "queued" TEXT,
    "inbox" TEXT,
    "job_checkpoint" TEXT${constraint}
)`,
    `CREATE INDEX IF NOT EXISTS "${table}_thread_id_created_at_idx" ON "${table}"("thread_id", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "${table}_state_deadline_at_idx" ON "${table}"("state", "deadline_at")`,
  ];
}
