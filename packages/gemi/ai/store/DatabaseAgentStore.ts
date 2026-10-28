import type { SQL, TransactionSQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { currentConnectionName, currentTransaction, withTransaction } from "../../orm/context";
import type { AgentStore } from "../AgentController";
import { keepSummary, type ThreadSummary } from "../contextCompaction";
import type { AgentMessage } from "../types";

export type DatabaseAgentStoreOptions = {
  /**
   * The threads table. Default `gemi_agent_threads`. A plain identifier
   * (letters, digits and underscores), because it is spliced into every
   * statement.
   */
  threadsTable?: string;
  /** The messages table. Default `gemi_agent_messages`. A plain identifier. */
  messagesTable?: string;
};

/** One thread, as `listThreads` and `getThread` answer it. */
export type AgentThreadRecord = {
  id: string;
  /** What `createThread` was given as `userId`, as a string, or `null`. */
  userId: string | null;
  /** The first user message's text, cut at 100 characters, once there is one. */
  title: string | null;
  /** Epoch milliseconds, from the database's clock. */
  createdAt: number;
  /** Epoch milliseconds of the last write. */
  updatedAt: number;
};

type Row = Record<string, unknown>;

/** Each SQLite client's transactions, chained so they run one at a time. */
const sqliteQueue = new WeakMap<SQL, Promise<void>>();

/** How much of the first user message becomes the thread's title. */
const TITLE_LENGTH = 100;

/**
 * Conversations (#1063) in two tables of the app's own database, so a thread
 * outlives the process and every instance reads the same one. The durable
 * `AgentStore`; `MemoryAgentStore` stays the default.
 *
 *     export class ChatController extends AgentController {
 *       agent = chatAgent;
 *       store = agentStore; // new DatabaseAgentStore(app(DatabaseManager).connection()), once, at module scope
 *     }
 *
 * Written for SQLite, Postgres and MySQL 8 / MariaDB 10.6+ in raw SQL, like
 * the other database stores, and the tables are the app's to create: add the
 * Prisma models from the docs, or call `createTable()`.
 *
 * - **Messages** are rows of JSON, one per message id, in the order the thread
 *   first saw them. `appendMessages` replaces a message it already holds in
 *   place, so a message written several times during a run keeps one row.
 * - **One writer per thread at a time.** An append runs in a transaction that
 *   first updates the thread's row, which locks it on Postgres and MySQL (and
 *   takes SQLite's write lock), so two appends to one thread cannot hand out
 *   the same position.
 * - **Summaries** for `contextWindow.compact` live on the thread's row and go
 *   with it; `lockSummary` is a compare-and-set on the same row, so several
 *   instances do not summarise the same thread at once.
 * - **Ownership is the app's.** `createThread` records the `userId` it is
 *   given and `listThreads` filters on it, but nothing here checks who is
 *   asking: the app's routes do, as they do for any thread id.
 */
export class DatabaseAgentStore implements AgentStore {
  readonly threadsTable: string;
  readonly messagesTable: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  private readonly connection: string | undefined;

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect"> &
      Partial<Pick<DatabaseConnection, "name">>,
    options: DatabaseAgentStoreOptions = {},
  ) {
    this.threadsTable = plainIdentifier(options.threadsTable ?? "gemi_agent_threads", "threads");
    this.messagesTable = plainIdentifier(
      options.messagesTable ?? "gemi_agent_messages",
      "messages",
    );
    this.sql = connection.sql;
    this.dialect = connection.dialect;
    this.connection = connection.name;
  }

  /**
   * Creates both tables and their indexes if they do not exist: the DDL Prisma
   * generates for the models in the docs. For tests and for an app that does
   * not manage its schema with Prisma.
   */
  async createTable(): Promise<void> {
    const statements = createAgentStoreTableStatements(
      this.dialect,
      this.threadsTable,
      this.messagesTable,
    );
    for (const statement of statements) await this.sql.unsafe(statement);
  }

  async createThread(params: { userId?: string | number }): Promise<{ threadId: string }> {
    const q = this.q();
    const threadId = crypto.randomUUID();
    const userId = params.userId === undefined || params.userId === null ? null : String(params.userId);
    const now = this.clock(q);
    await q`
      INSERT INTO ${this.threads(q)} (id, user_id, created_at, updated_at)
      VALUES (${threadId}, ${userId}, ${now}, ${now})
    `;
    return { threadId };
  }

  async loadThread(threadId: string): Promise<AgentMessage[] | null> {
    const q = this.q();
    const thread: Row[] = await q`SELECT id FROM ${this.threads(q)} WHERE id = ${threadId}`;
    if (thread.length === 0) return null;
    const rows: Row[] = await q`
      SELECT message FROM ${this.messages(q)}
      WHERE thread_id = ${threadId}
      ORDER BY position
    `;
    return rows.map((row) => JSON.parse(String(row.message)) as AgentMessage);
  }

  async appendMessages(threadId: string, messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) {
      // Still an error for a thread that is not there, like a non-empty one.
      if ((await this.getThread(threadId)) === null) throw missingThread(threadId);
      return;
    }
    await this.atomically(async (q) => {
      // The write lock first: the row on Postgres and MySQL, the database on
      // SQLite. Everything below reads and writes under it.
      await q`UPDATE ${this.threads(q)} SET updated_at = ${this.clock(q)} WHERE id = ${threadId}`;
      const thread: Row[] = await q`
        SELECT title FROM ${this.threads(q)} WHERE id = ${threadId}
      `;
      if (thread.length === 0) throw missingThread(threadId);

      const ids = [...new Set(messages.map((message) => message.id))];
      const held: Row[] = await q`
        SELECT id FROM ${this.messages(q)}
        WHERE thread_id = ${threadId} AND id IN (${list(q, ids)})
      `;
      const existing = new Set(held.map((row) => String(row.id)));
      const [last] = (await q`
        SELECT MAX(position) AS position FROM ${this.messages(q)} WHERE thread_id = ${threadId}
      `) as Row[];
      let position =
        last?.position === null || last?.position === undefined ? 0 : Number(last.position) + 1;

      for (const message of messages) {
        const body = JSON.stringify(message);
        if (existing.has(message.id)) {
          await q`
            UPDATE ${this.messages(q)} SET message = ${body}
            WHERE thread_id = ${threadId} AND id = ${message.id}
          `;
        } else {
          await q`
            INSERT INTO ${this.messages(q)} (thread_id, id, position, message, created_at)
            VALUES (${threadId}, ${message.id}, ${position}, ${body}, ${this.clock(q)})
          `;
          existing.add(message.id);
          position += 1;
        }
      }

      if (thread[0]!.title === null || thread[0]!.title === undefined) {
        const title = titleOf(messages);
        if (title !== null) {
          await q`
            UPDATE ${this.threads(q)} SET title = ${title}
            WHERE id = ${threadId} AND title IS NULL
          `;
        }
      }
    });
  }

  async removeMessages(threadId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const q = this.q();
    await q`
      DELETE FROM ${this.messages(q)}
      WHERE thread_id = ${threadId} AND id IN (${list(q, [...new Set(messageIds)])})
    `;
  }

  async loadSummaries(threadId: string): Promise<ThreadSummary[]> {
    const q = this.q();
    const [row] = (await q`
      SELECT summaries FROM ${this.threads(q)} WHERE id = ${threadId}
    `) as Row[];
    return row ? parseSummaries(row.summaries) : [];
  }

  async saveSummary(threadId: string, summary: ThreadSummary): Promise<void> {
    await this.atomically(async (q) => {
      await q`UPDATE ${this.threads(q)} SET updated_at = updated_at WHERE id = ${threadId}`;
      const [row] = (await q`
        SELECT summaries FROM ${this.threads(q)} WHERE id = ${threadId}
      `) as Row[];
      // A thread that is gone has nothing to summarise; the summary goes with it.
      if (!row) return;
      const summaries = keepSummary(parseSummaries(row.summaries), summary);
      await q`
        UPDATE ${this.threads(q)} SET summaries = ${JSON.stringify(summaries)}
        WHERE id = ${threadId}
      `;
    });
  }

  /**
   * A compare-and-set on the thread's row: taken when no one holds it or the
   * holder's `ttlMs` has run out. One lock per thread rather than per cut,
   * which only means two cuts of one thread are not summarised at once.
   */
  async lockSummary(
    threadId: string,
    cutMessageId: string,
    ttlMs: number,
  ): Promise<(() => Promise<void>) | null> {
    const q = this.q();
    const token = `${cutMessageId}:${crypto.randomUUID()}`;
    const now = this.clock(q);
    const result = await q`
      UPDATE ${this.threads(q)}
      SET summary_lock = ${token}, summary_lock_until = ${now} + ${this.ms(q, ttlMs)}
      WHERE id = ${threadId} AND (summary_lock_until IS NULL OR summary_lock_until <= ${now})
    `;
    if (affected(result) === 0) return null;
    return async () => {
      const q = this.q();
      await q`
        UPDATE ${this.threads(q)} SET summary_lock = NULL, summary_lock_until = NULL
        WHERE id = ${threadId} AND summary_lock = ${token}
      `;
    };
  }

  // --- for the app's own routes ------------------------------------------

  /** One thread's record, or `null` for an id the store does not have. */
  async getThread(threadId: string): Promise<AgentThreadRecord | null> {
    const q = this.q();
    const [row] = (await q`
      SELECT id, user_id, title, created_at, updated_at FROM ${this.threads(q)}
      WHERE id = ${threadId}
    `) as Row[];
    return row ? threadOf(row) : null;
  }

  /**
   * The threads, most recently written first: all of them, or one user's
   * (`userId` as `createThread` was given it). For a "your conversations"
   * list; `limit` defaults to 50, and `offset` pages.
   */
  async listThreads(
    options: { userId?: string | number | null; limit?: number; offset?: number } = {},
  ): Promise<AgentThreadRecord[]> {
    const q = this.q();
    const limit = Math.max(0, Math.floor(options.limit ?? 50));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const where =
      options.userId === undefined
        ? q`1 = 1`
        : options.userId === null
          ? q`user_id IS NULL`
          : q`user_id = ${String(options.userId)}`;
    const rows: Row[] = await q`
      SELECT id, user_id, title, created_at, updated_at FROM ${this.threads(q)}
      WHERE ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(threadOf);
  }

  /**
   * Deletes the thread, its messages and its summaries. An id the store does
   * not have is ignored. Agent memories scoped to the thread are not touched:
   * see `AgentMemories.deleteScope`.
   */
  async deleteThread(threadId: string): Promise<void> {
    await this.atomically(async (q) => {
      await q`DELETE FROM ${this.messages(q)} WHERE thread_id = ${threadId}`;
      await q`DELETE FROM ${this.threads(q)} WHERE id = ${threadId}`;
    });
  }

  // --- plumbing -------------------------------------------------------------

  /**
   * Runs `fn` in a transaction: a savepoint in the open ORM transaction when it
   * is on this store's connection, a transaction of its own otherwise.
   */
  private atomically<T>(fn: (q: SQL) => Promise<T>): Promise<T> {
    if (this.joinable()) {
      return withTransaction(this.sql, (tx) => fn(tx as unknown as SQL), {
        connection: this.connection,
      });
    }
    const begin = () => this.sql.begin((tx) => fn(tx as unknown as SQL)) as Promise<T>;
    if (this.dialect !== "sqlite") return begin();
    // One SQLite client is one connection, which holds one transaction at a
    // time: a second `begin` while the first is open fails with "cannot start
    // a transaction within a transaction". So this client's transactions take
    // turns. (Several clients on one file wait on SQLite's own lock.)
    const previous = sqliteQueue.get(this.sql) ?? Promise.resolve();
    const next = previous.then(begin, begin);
    sqliteQueue.set(
      this.sql,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
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

  private quote(name: string) {
    return this.dialect === "mysql" || this.dialect === "mariadb" ? `\`${name}\`` : `"${name}"`;
  }

  private threads(q: SQL) {
    return q.unsafe(this.quote(this.threadsTable));
  }

  private messages(q: SQL) {
    return q.unsafe(this.quote(this.messagesTable));
  }

  /** The database's clock, in epoch milliseconds. As in `DatabaseAgentJobStore`. */
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

function plainIdentifier(table: string, which: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(
      `The agent ${which} table name "${table}" is not a plain identifier. Use letters, digits and underscores.`,
    );
  }
  return table;
}

function missingThread(threadId: string): Error {
  // As `MemoryAgentStore` says it: the controller checks before the run and
  // never reaches this; a store-level caller that does gets told.
  return new Error(`Thread ${threadId} does not exist here, or has been deleted.`);
}

function list(q: SQL, values: string[]) {
  return values.map((value) => q`${value}`).reduce((all, one) => q`${all}, ${one}`);
}

function titleOf(messages: AgentMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1)}…` : text;
  }
  return null;
}

function parseSummaries(value: unknown): ThreadSummary[] {
  if (value === null || value === undefined || value === "") return [];
  const parsed = JSON.parse(String(value));
  return Array.isArray(parsed) ? (parsed as ThreadSummary[]) : [];
}

function threadOf(row: Row): AgentThreadRecord {
  return {
    id: String(row.id),
    userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Rows an `UPDATE` touched, across the three drivers. */
function affected(result: unknown): number {
  const counts = result as { count?: number | null; affectedRows?: number | null };
  return Math.max(Number(counts.count ?? 0), Number(counts.affectedRows ?? 0));
}

/**
 * The tables as Prisma generates them for the models in the docs, with
 * `IF NOT EXISTS` added.
 */
export function createAgentStoreTableStatements(
  dialect: Dialect,
  threadsTable: string,
  messagesTable: string,
): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${threadsTable}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`user_id\` VARCHAR(191) NULL,
    \`title\` TEXT NULL,
    \`summaries\` LONGTEXT NULL,
    \`summary_lock\` VARCHAR(191) NULL,
    \`summary_lock_until\` BIGINT NULL,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,

    INDEX \`${threadsTable}_user_id_updated_at_idx\`(\`user_id\`, \`updated_at\`),
    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS \`${messagesTable}\` (
    \`thread_id\` VARCHAR(191) NOT NULL,
    \`id\` VARCHAR(191) NOT NULL,
    \`position\` INTEGER NOT NULL,
    \`message\` LONGTEXT NOT NULL,
    \`created_at\` BIGINT NOT NULL,

    UNIQUE INDEX \`${messagesTable}_thread_id_position_key\`(\`thread_id\`, \`position\`),
    PRIMARY KEY (\`thread_id\`, \`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ];
  }

  const threadsKey =
    dialect === "sqlite" ? `"id" TEXT NOT NULL PRIMARY KEY,` : `"id" TEXT NOT NULL,`;
  const threadsConstraint =
    dialect === "sqlite" ? "" : `,\n\n    CONSTRAINT "${threadsTable}_pkey" PRIMARY KEY ("id")`;
  return [
    `CREATE TABLE IF NOT EXISTS "${threadsTable}" (
    ${threadsKey}
    "user_id" TEXT,
    "title" TEXT,
    "summaries" TEXT,
    "summary_lock" TEXT,
    "summary_lock_until" BIGINT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL${threadsConstraint}
)`,
    `CREATE INDEX IF NOT EXISTS "${threadsTable}_user_id_updated_at_idx" ON "${threadsTable}"("user_id", "updated_at")`,
    `CREATE TABLE IF NOT EXISTS "${messagesTable}" (
    "thread_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "${messagesTable}_pkey" PRIMARY KEY ("thread_id", "id")
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "${messagesTable}_thread_id_position_key" ON "${messagesTable}"("thread_id", "position")`,
  ];
}
