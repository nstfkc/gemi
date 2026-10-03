import type { SQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { runOnConnection, withTransaction } from "../../orm/context";
import { LockLostError, type LockStore } from "./LockStore";

export type DatabaseLockStoreOptions = {
  /**
   * The locks table. Default `gemi_locks`. A plain identifier, because it is
   * spliced into every statement.
   */
  table?: string;
  /**
   * SQLite only: the busy timeout given to a connection still at SQLite's `0`,
   * as `DatabaseQueueDriver` does. Default `1000`; `0` leaves the connection
   * alone.
   */
  busyTimeout?: number;
};

/**
 * Locks in a table of the application's database, so every process sharing
 * the database sees the same holder. One row per lock name, kept after
 * release so the name's fencing token keeps growing.
 *
 * Every statement is a single atomic row update, guarded by the holder's
 * owner, token and lease: `acquire` is "take the row if its lease ran out",
 * `extend` and `release` are "change the row if it is still mine". Leases are
 * measured on the database's clock, as the queue's are, so skewed replicas
 * agree on when one ran out. No Redis is involved.
 *
 * `fence` opens a transaction that locks the row first (`SELECT … FOR UPDATE`
 * on Postgres and MySQL, a write on SQLite, which takes the file's write
 * lock), so a new holder's `acquire` waits until the fenced work commits.
 *
 * Written for SQLite, Postgres and MySQL 8 / MariaDB 10.6+, like the queue's
 * driver.
 */
export class DatabaseLockStore implements LockStore {
  readonly table: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  private readonly connection: string | undefined;
  private readonly busyTimeout: number;
  private configured: Promise<void> | undefined;

  constructor(
    connection: Pick<DatabaseConnection, "sql" | "dialect"> &
      Partial<Pick<DatabaseConnection, "name">>,
    options: DatabaseLockStoreOptions = {},
  ) {
    const table = options.table ?? "gemi_locks";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(
        `The lock table name "${table}" is not a plain identifier. Use ` +
          `letters, digits and underscores.`,
      );
    }
    this.table = table;
    this.sql = connection.sql;
    this.dialect = connection.dialect;
    this.connection = connection.name;
    this.busyTimeout = options.busyTimeout ?? 1000;
  }

  /** Creates the table if it does not exist; the DDL Prisma makes for the model in the docs. */
  async createTable(): Promise<void> {
    await this.configure();
    for (const statement of createLockTableStatements(this.dialect, this.table)) {
      await this.sql.unsafe(statement);
    }
  }

  async acquire(name: string, owner: string, ttlMs: number): Promise<number | null> {
    await this.configure();
    const q = this.sql;
    const now = this.now(q);
    await this.seed(q, name);

    if (this.mysql) {
      const result = await q`
        UPDATE ${this.name(q)}
        SET owner = ${owner}, token = token + 1, expires_at = ${now} + ${this.ms(q, ttlMs)},
            updated_at = ${now}
        WHERE name = ${name} AND expires_at <= ${now}
      `;
      if (affected(result) === 0) return null;
      // The owner is unique to this acquisition, so this reads our own row
      // unless the lease already ran out and was taken again.
      const [row] = (await q`
        SELECT token FROM ${this.name(q)} WHERE name = ${name} AND owner = ${owner}
      `) as Array<{ token: unknown }>;
      return row ? Number(row.token) : null;
    }

    const rows = (await q`
      UPDATE ${this.name(q)}
      SET owner = ${owner}, token = token + 1, expires_at = ${now} + ${this.ms(q, ttlMs)},
          updated_at = ${now}
      WHERE name = ${name} AND expires_at <= ${now}
      RETURNING token
    `) as Array<{ token: unknown }>;
    return rows[0] ? Number(rows[0].token) : null;
  }

  async extend(name: string, owner: string, token: number, ttlMs: number): Promise<boolean> {
    await this.configure();
    const q = this.sql;
    const now = this.now(q);
    const result = await q`
      UPDATE ${this.name(q)}
      SET expires_at = ${now} + ${this.ms(q, ttlMs)}, updated_at = ${now}
      WHERE name = ${name} AND owner = ${owner} AND token = ${token} AND expires_at > ${now}
    `;
    if (affected(result) > 0) return true;
    // MySQL counts changed rows, not matched ones, so a renewal that lands in
    // the same millisecond as the last one reports nothing changed.
    return this.mysql ? this.held(name, owner, token) : false;
  }

  async release(name: string, owner: string, token?: number): Promise<boolean> {
    await this.configure();
    const q = this.sql;
    const now = this.now(q);
    const byToken = token === undefined ? q`1 = 1` : q`token = ${token}`;
    const result = await q`
      UPDATE ${this.name(q)}
      SET owner = '', expires_at = 0, updated_at = ${now}
      WHERE name = ${name} AND owner = ${owner} AND ${byToken} AND expires_at > ${now}
    `;
    return affected(result) > 0;
  }

  async holder(name: string): Promise<{ owner: string; token: number } | null> {
    await this.configure();
    const q = this.sql;
    const [row] = (await q`
      SELECT owner, token FROM ${this.name(q)}
      WHERE name = ${name} AND expires_at > ${this.now(q)}
    `) as Array<{ owner: unknown; token: unknown }>;
    return row ? { owner: String(row.owner), token: Number(row.token) } : null;
  }

  async held(name: string, owner: string, token: number): Promise<boolean> {
    await this.configure();
    const q = this.sql;
    const rows = (await q`
      SELECT 1 AS held FROM ${this.name(q)}
      WHERE name = ${name} AND owner = ${owner} AND token = ${token} AND expires_at > ${this.now(q)}
    `) as unknown[];
    return rows.length > 0;
  }

  async advance(name: string, value: number): Promise<boolean> {
    await this.configure();
    const q = this.sql;
    await this.seed(q, name);
    const result = await q`
      UPDATE ${this.name(q)}
      SET token = ${this.int(q, value)}, updated_at = ${this.now(q)}
      WHERE name = ${name} AND token < ${this.int(q, value)}
    `;
    return affected(result) > 0;
  }

  async fence<T>(name: string, owner: string, token: number, fn: () => Promise<T>): Promise<T> {
    await this.configure();
    const body = async (tx: SQL) => {
      const now = this.now(tx);
      let ok: boolean;
      if (this.dialect === "sqlite") {
        // SQLite has no row locks; a write takes the file's write lock until
        // the commit, which is what keeps another holder out.
        const result = await tx`
          UPDATE ${this.name(tx)} SET updated_at = ${now}
          WHERE name = ${name} AND owner = ${owner} AND token = ${token} AND expires_at > ${now}
        `;
        ok = affected(result) > 0;
      } else {
        const rows = (await tx`
          SELECT 1 AS held FROM ${this.name(tx)}
          WHERE name = ${name} AND owner = ${owner} AND token = ${token} AND expires_at > ${now}
          FOR UPDATE
        `) as unknown[];
        ok = rows.length > 0;
      }
      if (!ok) throw new LockLostError(name, token);
      return fn();
    };

    const connection = this.connection;
    if (connection === undefined) {
      return (await this.sql.begin((tx) => body(tx))) as T;
    }
    // An ORM transaction on the store's own connection, so model writes in
    // `fn` join it and commit only while the hold is current.
    return withTransaction(this.sql, (tx) => runOnConnection(connection, () => body(tx)), {
      connection,
    });
  }

  /**
   * A fixed window in the lock's row: `token` is the count and `expires_at`
   * the window's end. One guarded `UPDATE` either starts a new window, counts
   * a hit in the current one, or matches nothing because it is full.
   */
  async hit(name: string, limit: number, windowMs: number) {
    await this.configure();
    const q = this.sql;
    const now = this.now(q);
    await this.seed(q, name);
    const window = this.ms(q, Math.max(1, windowMs));
    const result = await q`
      UPDATE ${this.name(q)}
      SET token = CASE WHEN expires_at <= ${now} THEN 1 ELSE token + 1 END,
          expires_at = CASE WHEN expires_at <= ${now} THEN ${now} + ${window} ELSE expires_at END,
          updated_at = ${now}
      WHERE name = ${name} AND (expires_at <= ${now} OR token < ${this.int(q, limit)})
    `;
    const allowed = affected(result) > 0;
    const [row] = (await q`
      SELECT expires_at - ${now} AS reset FROM ${this.name(q)} WHERE name = ${name}
    `) as Array<{ reset: unknown }>;
    return { allowed, resetInMs: Math.max(0, Number(row?.reset ?? 0)) };
  }

  async refund(name: string) {
    await this.configure();
    const q = this.sql;
    const now = this.now(q);
    await q`
      UPDATE ${this.name(q)} SET token = token - 1, updated_at = ${now}
      WHERE name = ${name} AND token > 0 AND expires_at > ${now}
    `;
  }

  /**
   * Deletes locks that are free and were last touched more than `olderThanMs`
   * ago, and resolves to how many. Tokens start again from 1 for a pruned
   * name, so keep `olderThanMs` far above any lease.
   */
  async prune(olderThanMs: number): Promise<number> {
    await this.configure();
    const q = this.sql;
    const now = this.now(q);
    const result = await q`
      DELETE FROM ${this.name(q)}
      WHERE expires_at <= ${now} AND updated_at <= ${now} - ${this.ms(q, olderThanMs)}
    `;
    return affected(result);
  }

  /** Makes sure the name has a row, free, so the guarded `UPDATE`s have something to match. */
  private async seed(q: SQL, name: string) {
    const now = this.now(q);
    if (this.mysql) {
      await q`
        INSERT IGNORE INTO ${this.name(q)} (name, owner, token, expires_at, updated_at)
        VALUES (${name}, '', 0, 0, ${now})
      `;
      return;
    }
    await q`
      INSERT INTO ${this.name(q)} (name, owner, token, expires_at, updated_at)
      VALUES (${name}, '', 0, 0, ${now})
      ON CONFLICT (name) DO NOTHING
    `;
  }

  private get mysql() {
    return this.dialect === "mysql" || this.dialect === "mariadb";
  }

  /** See `DatabaseQueueDriver.configure`. */
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

  private name(q: SQL) {
    return q.unsafe(this.mysql ? `\`${this.table}\`` : `"${this.table}"`);
  }

  /** The database's clock in epoch milliseconds, as the queue driver reads it. */
  private now(q: SQL) {
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
    return this.int(q, Math.max(0, Math.round(value)));
  }

  private int(q: SQL, value: number) {
    const n = Math.round(value);
    return this.mysql ? q`CAST(${n} AS SIGNED)` : q`CAST(${n} AS BIGINT)`;
  }
}

function affected(result: unknown): number {
  const counts = result as { count?: number | null; affectedRows?: number | null };
  return Math.max(Number(counts.count ?? 0), Number(counts.affectedRows ?? 0));
}

/** The locks table, as Prisma generates it for the model in the docs, with `IF NOT EXISTS`. */
export function createLockTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`name\` VARCHAR(191) NOT NULL,
    \`owner\` VARCHAR(191) NOT NULL,
    \`token\` BIGINT NOT NULL DEFAULT 0,
    \`expires_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,

    PRIMARY KEY (\`name\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ];
  }
  const key = dialect === "sqlite" ? `"name" TEXT NOT NULL PRIMARY KEY,` : `"name" TEXT NOT NULL,`;
  const constraint =
    dialect === "sqlite" ? "" : `,\n\n    CONSTRAINT "${table}_pkey" PRIMARY KEY ("name")`;
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (
    ${key}
    "owner" TEXT NOT NULL,
    "token" BIGINT NOT NULL DEFAULT 0,
    "expires_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL${constraint}
)`,
  ];
}
