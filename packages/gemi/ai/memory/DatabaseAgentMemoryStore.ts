import type { SQL, TransactionSQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { currentConnectionName, currentTransaction } from "../../orm/context";
import {
  type AgentMemoryListOptions,
  type AgentMemoryRecord,
  type AgentMemorySearchOptions,
  type AgentMemorySource,
  type AgentMemoryStore,
  type AgentMemoryUpdate,
  type AgentMemoryWriteAction,
  hasAnyTag,
  type NewAgentMemoryRecord,
  sameMemory,
} from "./AgentMemoryStore";
import { rankMemories } from "./search";

export type DatabaseAgentMemoryStoreOptions = {
  /**
   * The table. Default `gemi_agent_memories`. A plain identifier (letters,
   * digits and underscores), because it is spliced into every statement.
   */
  table?: string;
};

type Row = Record<string, unknown>;

/** How many times a keyed write retries when another write to the same key got there first. */
const UPSERT_ATTEMPTS = 4;

/**
 * Agent memories (#936) in a table of the app's own database, so they outlive
 * the process and every instance sees the same ones.
 *
 *     AgentMemories.use(new DatabaseAgentMemoryStore(app(DatabaseManager).connection()));
 *
 * Written for SQLite, Postgres and MySQL 8 / MariaDB 10.6+ in raw SQL, like
 * `DatabaseAgentJobStore`, and the table is the app's to create: add the
 * Prisma model from docs/ai-memory.md, or call `createTable()`.
 *
 * - **One memory per scope and key**: a unique index on `(scope, key)`. A
 *   keyed write reads the slot and updates it by compare-and-set on
 *   `version`, or inserts; two writes racing on one key end with one memory.
 * - **Time** is epoch milliseconds read from the database's clock.
 * - **Search** loads the scopes' memories and ranks them in JavaScript
 *   (`rankMemories`), the same on every database. A scope is small.
 * - **Deletes are hard.** Nothing is kept of a deleted memory; an app that
 *   wants a trail uses `AgentMemories.use(store, { onWrite })`.
 */
export class DatabaseAgentMemoryStore implements AgentMemoryStore {
  readonly table: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  private readonly connection: string | undefined;

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect"> &
      Partial<Pick<DatabaseConnection, "name">>,
    options: DatabaseAgentMemoryStoreOptions = {},
  ) {
    const table = options.table ?? "gemi_agent_memories";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(
        `The agent memories table name "${table}" is not a plain identifier. Use letters, digits and underscores.`,
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
    for (const statement of createAgentMemoriesTableStatements(this.dialect, this.table)) {
      await this.sql.unsafe(statement);
    }
  }

  async list(
    scopes: readonly string[],
    options: AgentMemoryListOptions = {},
  ): Promise<AgentMemoryRecord[]> {
    if (scopes.length === 0) return [];
    if (options.kinds !== undefined && options.kinds.length === 0) return [];
    const q = this.q();
    const where = [q`scope IN (${list(q, scopes)})`];
    if (options.kinds !== undefined) where.push(q`kind IN (${list(q, options.kinds)})`);
    if (!options.includeExpired) {
      where.push(q`(expires_at IS NULL OR expires_at > ${this.clock(q)})`);
    }
    if (options.after !== undefined) {
      const [cursor]: Row[] = await q`
        SELECT created_at, id FROM ${this.name(q)}
        WHERE id = ${options.after} AND scope IN (${list(q, scopes)})
      `;
      if (cursor) {
        const createdAt = this.ms(q, Number(cursor.created_at));
        where.push(
          q`(created_at > ${createdAt} OR (created_at = ${createdAt} AND id > ${String(cursor.id)}))`,
        );
      }
    }
    const condition = where.reduce((all, one) => q`${all} AND ${one}`);
    // Tags are a JSON column, filtered here rather than in SQL, so a limit
    // has to wait until they are.
    const limit =
      options.limit === undefined || options.tags !== undefined
        ? undefined
        : Math.max(0, Math.floor(options.limit));
    const rows: Row[] =
      limit === undefined
        ? await q`
            SELECT * FROM ${this.name(q)} WHERE ${condition}
            ORDER BY created_at, id
          `
        : await q`
            SELECT * FROM ${this.name(q)} WHERE ${condition}
            ORDER BY created_at, id
            LIMIT ${limit}
          `;
    let records = rows.map(recordOf);
    if (options.tags !== undefined) {
      records = records.filter((record) => hasAnyTag(record, options.tags));
      if (options.limit !== undefined) {
        records = records.slice(0, Math.max(0, Math.floor(options.limit)));
      }
    }
    return records;
  }

  async get(id: string): Promise<AgentMemoryRecord | null> {
    const q = this.q();
    const rows: Row[] = await q`SELECT * FROM ${this.name(q)} WHERE id = ${id}`;
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async upsert(
    memory: NewAgentMemoryRecord,
  ): Promise<{ record: AgentMemoryRecord; action: AgentMemoryWriteAction }> {
    const key = memory.key ?? null;
    if (key === null) {
      await this.insert(memory, null);
      return { record: await this.mustGet(memory.id), action: "added" };
    }
    for (let attempt = 1; ; attempt++) {
      const existing = await this.atKey(memory.scope, key);
      if (existing) {
        if (sameMemory(existing, memory)) return { record: existing, action: "unchanged" };
        const record = await this.update(
          existing.id,
          {
            kind: memory.kind,
            content: memory.content,
            tags: memory.tags ?? [],
            pinned: memory.pinned ?? false,
            expiresAt: memory.expiresAt ?? null,
          },
          existing.version,
        );
        if (record) return { record, action: "updated" };
      } else {
        try {
          await this.insert(memory, key);
          return { record: await this.mustGet(memory.id), action: "added" };
        } catch (error) {
          // Another write took the key between the read and the insert; the
          // next attempt finds it and updates it. Anything else is rethrown
          // once the slot is still empty.
          if (attempt >= UPSERT_ATTEMPTS || !(await this.atKey(memory.scope, key))) throw error;
        }
      }
      if (attempt >= UPSERT_ATTEMPTS) {
        throw new Error(
          `The memory at "${key}" in ${memory.scope} kept changing while it was being written.`,
        );
      }
    }
  }

  async update(
    id: string,
    patch: AgentMemoryUpdate,
    expectedVersion?: number,
  ): Promise<AgentMemoryRecord | null> {
    const q = this.q();
    const sets = [q`version = version + 1`, q`updated_at = ${this.clock(q)}`];
    if (patch.kind !== undefined) sets.push(q`kind = ${patch.kind}`);
    if (patch.content !== undefined) sets.push(q`content = ${patch.content}`);
    if (patch.key !== undefined) sets.push(q`${this.column(q, "key")} = ${patch.key}`);
    if (patch.tags !== undefined) sets.push(q`tags = ${JSON.stringify(patch.tags)}`);
    if (patch.pinned !== undefined) sets.push(q`pinned = ${patch.pinned ? 1 : 0}`);
    if (patch.expiresAt !== undefined) {
      sets.push(
        patch.expiresAt === null
          ? q`expires_at = NULL`
          : q`expires_at = ${this.ms(q, patch.expiresAt)}`,
      );
    }
    const set = sets.reduce((all, one) => q`${all}, ${one}`);
    const result =
      expectedVersion === undefined
        ? await q`UPDATE ${this.name(q)} SET ${set} WHERE id = ${id}`
        : await q`
            UPDATE ${this.name(q)} SET ${set}
            WHERE id = ${id} AND version = ${Math.floor(expectedVersion)}
          `;
    if (affected(result) === 0) return null;
    return this.get(id);
  }

  async delete(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const q = this.q();
    const result = await q`DELETE FROM ${this.name(q)} WHERE id IN (${list(q, [...new Set(ids)])})`;
    return affected(result);
  }

  async deleteScope(scope: string): Promise<number> {
    const q = this.q();
    return affected(await q`DELETE FROM ${this.name(q)} WHERE scope = ${scope}`);
  }

  async search(
    scopes: readonly string[],
    query: string,
    options: AgentMemorySearchOptions = {},
  ): Promise<AgentMemoryRecord[]> {
    const rows = await this.list(scopes, { kinds: options.kinds, tags: options.tags });
    return rankMemories(rows, query, options.limit);
  }

  async count(scope: string): Promise<number> {
    const q = this.q();
    const [row] = (await q`
      SELECT COUNT(*) AS total FROM ${this.name(q)}
      WHERE scope = ${scope} AND (expires_at IS NULL OR expires_at > ${this.clock(q)})
    `) as Array<{ total: unknown }>;
    return Number(row?.total ?? 0);
  }

  async touch(ids: readonly string[], at: number): Promise<void> {
    if (ids.length === 0) return;
    const q = this.q();
    await q`
      UPDATE ${this.name(q)} SET last_used_at = ${this.ms(q, at)}
      WHERE id IN (${list(q, [...new Set(ids)])})
    `;
  }

  async prune(now: number): Promise<number> {
    const q = this.q();
    return affected(
      await q`DELETE FROM ${this.name(q)} WHERE expires_at IS NOT NULL AND expires_at <= ${this.ms(q, now)}`,
    );
  }

  /** The store's clock, in epoch milliseconds. */
  async now(): Promise<number> {
    const q = this.q();
    const [row] = (await q`SELECT ${this.clock(q)} AS now`) as Array<{ now: unknown }>;
    return Number(row!.now);
  }

  private async insert(memory: NewAgentMemoryRecord, key: string | null): Promise<void> {
    const q = this.q();
    const now = this.clock(q);
    const expiresAt =
      memory.expiresAt === undefined || memory.expiresAt === null
        ? null
        : Math.max(0, Math.round(memory.expiresAt));
    await q`
      INSERT INTO ${this.name(q)}
        (id, scope, kind, ${this.column(q, "key")}, content, tags, pinned, source, version,
         created_at, updated_at, expires_at)
      VALUES
        (${memory.id}, ${memory.scope}, ${memory.kind}, ${key}, ${memory.content},
         ${JSON.stringify(memory.tags ?? [])}, ${memory.pinned ? 1 : 0},
         ${JSON.stringify(memory.source)}, 1, ${now}, ${now},
         ${expiresAt === null ? null : this.ms(q, expiresAt)})
    `;
  }

  private async atKey(scope: string, key: string): Promise<AgentMemoryRecord | null> {
    const q = this.q();
    const rows: Row[] = await q`
      SELECT * FROM ${this.name(q)} WHERE scope = ${scope} AND ${this.column(q, "key")} = ${key}
    `;
    return rows[0] ? recordOf(rows[0]) : null;
  }

  private async mustGet(id: string): Promise<AgentMemoryRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`The memory ${id} was not found after it was written.`);
    return record;
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

  /** `key` is a reserved word in MySQL, so it is always quoted. */
  private column(q: SQL, name: string) {
    const mysql = this.dialect === "mysql" || this.dialect === "mariadb";
    return q.unsafe(mysql ? `\`${name}\`` : `"${name}"`);
  }

  private name(q: SQL) {
    const mysql = this.dialect === "mysql" || this.dialect === "mariadb";
    return q.unsafe(mysql ? `\`${this.table}\`` : `"${this.table}"`);
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

function list(q: SQL, values: readonly string[]) {
  return values.map((value) => q`${value}`).reduce((all, one) => q`${all}, ${one}`);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function recordOf(row: Row): AgentMemoryRecord {
  const tags = parseJson<unknown>(row.tags, []);
  return {
    id: String(row.id),
    scope: String(row.scope),
    kind: String(row.kind),
    content: String(row.content),
    key: row.key === null || row.key === undefined ? null : String(row.key),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    pinned: Number(row.pinned) === 1,
    source: parseJson<AgentMemorySource>(row.source, { by: "app" }),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt:
      row.last_used_at === null || row.last_used_at === undefined
        ? null
        : Number(row.last_used_at),
    expiresAt:
      row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
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
export function createAgentMemoriesTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`scope\` VARCHAR(191) NOT NULL,
    \`kind\` VARCHAR(191) NOT NULL,
    \`key\` VARCHAR(191) NULL,
    \`content\` TEXT NOT NULL,
    \`tags\` TEXT NULL,
    \`pinned\` INTEGER NOT NULL DEFAULT 0,
    \`source\` TEXT NOT NULL,
    \`version\` INTEGER NOT NULL DEFAULT 1,
    \`embedding\` LONGTEXT NULL,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,
    \`last_used_at\` BIGINT NULL,
    \`expires_at\` BIGINT NULL,

    INDEX \`${table}_scope_kind_created_at_idx\`(\`scope\`, \`kind\`, \`created_at\`),
    INDEX \`${table}_expires_at_idx\`(\`expires_at\`),
    UNIQUE INDEX \`${table}_scope_key_key\`(\`scope\`, \`key\`),
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
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT,
    "content" TEXT NOT NULL,
    "tags" TEXT,
    "pinned" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "embedding" TEXT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "last_used_at" BIGINT,
    "expires_at" BIGINT${constraint}
)`,
    `CREATE INDEX IF NOT EXISTS "${table}_scope_kind_created_at_idx" ON "${table}"("scope", "kind", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "${table}_expires_at_idx" ON "${table}"("expires_at")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_scope_key_key" ON "${table}"("scope", "key")`,
  ];
}
