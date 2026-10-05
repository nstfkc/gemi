import type { SQL, TransactionSQL } from "bun";

import type { DatabaseConnection } from "../../database/Connection";
import type { Dialect } from "../../database/dialect";
import { commitDependsOn, currentConnectionName, currentTransaction } from "../../orm/context";
import type { ChangeFeedDriver, ChangeFeedRead } from "./ChangeFeedDriver";
import { defaultPostgresListener, type PostgresListenerFactory } from "./postgresListen";

export type DatabaseChangeFeedDriverOptions = {
  /** The heads table: one row per channel. Default `gemi_change_heads`. */
  headsTable?: string;
  /** The entries table: the kept log. Default `gemi_changes`. */
  entriesTable?: string;
  /** Entries kept per channel. Default `1000`. */
  retain?: number;
  /**
   * The Postgres `NOTIFY` channel that wakes other instances. Default
   * `gemi_changes`. Instances share a feed only when they use the same one.
   */
  notifyChannel?: string;
  /**
   * Opens the `LISTEN` connection. Default: Bun's `SQL` on Bun 1.4 and later,
   * the `postgres` package (an optional peer dependency) before that.
   */
  listener?: PostgresListenerFactory;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Connection = Pick<DatabaseConnection, "sql" | "dialect"> &
  Partial<Pick<DatabaseConnection, "name" | "url">>;

/**
 * A change feed kept in two tables of the application's database: a head row
 * per channel holding its latest seq, and the last `retain` entries of each
 * channel. Works on Postgres and SQLite; MySQL is not supported yet.
 *
 * ### Publishing
 *
 * A publish raises the channel's head with an upsert and inserts the entry,
 * in one transaction: the caller's ORM transaction when one is open on this
 * driver's connection (Postgres only, see `transaction`), its own otherwise.
 * The upsert locks the head row until that transaction ends, so publishers to
 * one channel take turns and seqs become visible in order. Publishers to
 * different channels do not wait for each other.
 *
 * ### Across instances
 *
 * On Postgres a publish also runs `pg_notify` in the same transaction, which
 * Postgres delivers only on commit, and only if it commits. `listen` holds
 * one `LISTEN` connection per process; a reconnect after a drop calls
 * `onResync`, because notifications sent meanwhile are gone. On SQLite there
 * is nobody else to tell: one process owns the file.
 */
export class DatabaseChangeFeedDriver implements ChangeFeedDriver {
  readonly headsTable: string;
  readonly entriesTable: string;
  readonly notifyChannel: string;
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  private readonly connection: string | undefined;
  private readonly url: string | undefined;
  private readonly retain: number;
  private readonly listener: PostgresListenerFactory;
  private sqliteTurn: Promise<unknown> = Promise.resolve();

  constructor(connection: Connection, options: DatabaseChangeFeedDriverOptions = {}) {
    if (connection.dialect !== "postgres" && connection.dialect !== "sqlite") {
      throw new Error(
        `The change feed's database driver supports Postgres and SQLite, not ${connection.dialect}.`,
      );
    }
    const headsTable = options.headsTable ?? "gemi_change_heads";
    const entriesTable = options.entriesTable ?? "gemi_changes";
    const notifyChannel = options.notifyChannel ?? "gemi_changes";
    for (const name of [headsTable, entriesTable, notifyChannel]) {
      if (!IDENTIFIER.test(name)) {
        throw new Error(
          `"${name}" is not a plain identifier. Use letters, digits and underscores.`,
        );
      }
    }
    const retain = options.retain ?? 1000;
    if (!Number.isInteger(retain) || retain < 1) {
      throw new Error(`The change feed's retain must be a whole number, 1 or more; got ${retain}.`);
    }
    this.headsTable = headsTable;
    this.entriesTable = entriesTable;
    this.notifyChannel = notifyChannel;
    this.sql = connection.sql;
    this.dialect = connection.dialect;
    this.connection = connection.name;
    this.url = connection.url;
    this.retain = retain;
    this.listener = options.listener ?? defaultPostgresListener;
  }

  /**
   * Creates both tables if they do not exist, the same DDL Prisma generates
   * for the models in the docs. For tests and apps that do not manage their
   * schema with Prisma.
   */
  async createTable(): Promise<void> {
    for (const statement of createTableStatements(this.headsTable, this.entriesTable)) {
      await this.sql.unsafe(statement);
    }
  }

  joinsTransaction(): boolean {
    return this.transaction() !== undefined;
  }

  publish(channel: string, data: unknown): Promise<number> {
    // Read at the call, never kept: Bun's handle stays callable after its
    // transaction ended and then runs on the pool, outside any transaction.
    const tx = this.transaction();
    if (!tx) {
      const publish = () => this.sql.begin((own) => this.append(own, channel, data));
      if (this.dialect !== "sqlite") return publish();
      // Bun gives SQLite one connection, and a second `begin` while one is
      // open fails ("cannot start a transaction within a transaction"), so
      // this process's publishes take turns.
      const turn = this.sqliteTurn.then(publish);
      this.sqliteTurn = turn.catch(() => {});
      return turn;
    }
    const written = this.append(tx, channel, data);
    // A failed statement aborts a Postgres transaction, and a COMMIT after
    // that is quietly a rollback. Tying the commit to the write makes the
    // failure the caller's error even when the caller did not await.
    commitDependsOn(written);
    return written;
  }

  private async append(q: SQL, channel: string, data: unknown): Promise<number> {
    const heads = q.unsafe(`"${this.headsTable}"`);
    const entries = q.unsafe(`"${this.entriesTable}"`);
    const [row] = await q`
      INSERT INTO ${heads} (channel, seq) VALUES (${channel}, 1)
      ON CONFLICT (channel) DO UPDATE SET seq = ${heads}.seq + 1
      RETURNING seq
    `;
    const seq = Number(row.seq);
    await q`
      INSERT INTO ${entries} (channel, seq, data, created_at)
      VALUES (${channel}, ${seq}, ${JSON.stringify(data ?? null)}, ${Date.now()})
    `;
    if (seq > this.retain) {
      await q`DELETE FROM ${entries} WHERE channel = ${channel} AND seq <= ${seq - this.retain}`;
    }
    if (this.dialect === "postgres") {
      await q`SELECT pg_notify(${this.notifyChannel}, ${`${seq} ${channel}`})`;
    }
    return seq;
  }

  async heads(channels: readonly string[]): Promise<Map<string, number>> {
    const heads = new Map(channels.map((channel) => [channel, 0]));
    if (channels.length === 0) return heads;
    const q = this.sql;
    const rows: { channel: string; seq: number | string }[] = await q`
      SELECT channel, seq FROM ${q.unsafe(`"${this.headsTable}"`)}
      WHERE channel IN ${q([...channels])}
    `;
    for (const row of rows) heads.set(row.channel, Number(row.seq));
    return heads;
  }

  async read(channel: string, after: number, limit: number): Promise<ChangeFeedRead> {
    const q = this.sql;
    const [found] = await q`
      SELECT seq FROM ${q.unsafe(`"${this.headsTable}"`)} WHERE channel = ${channel}
    `;
    const head = found ? Number(found.seq) : 0;
    if (after > head) return { entries: [], head, gap: true };
    if (after === head) return { entries: [], head, gap: false };
    const rows: { seq: number | string; data: string }[] = await q`
      SELECT seq, data FROM ${q.unsafe(`"${this.entriesTable}"`)}
      WHERE channel = ${channel} AND seq > ${after}
      ORDER BY seq
      LIMIT ${limit}
    `;
    if (rows.length === 0 || Number(rows[0]!.seq) !== after + 1) {
      return { entries: [], head, gap: true };
    }
    return {
      entries: rows.map((row) => ({ seq: Number(row.seq), data: JSON.parse(row.data) })),
      head,
      gap: false,
    };
  }

  async listen(
    onChange: (channel: string, seq: number) => void,
    onResync: () => void,
  ): Promise<{ close(): Promise<void> }> {
    // One process owns a SQLite file, and the manager wakes its own
    // subscribers after each publish.
    if (this.dialect !== "postgres") return { close: async () => {} };
    if (!this.url) {
      throw new Error(
        "The change feed's database driver needs the connection's url to LISTEN. " +
          "Build it from a DatabaseManager connection, which has one.",
      );
    }
    const client = await this.listener(this.url);
    try {
      await client.listen(
        this.notifyChannel,
        (payload) => {
          const space = payload.indexOf(" ");
          const seq = Number(payload.slice(0, space));
          if (space > 0 && Number.isInteger(seq)) onChange(payload.slice(space + 1), seq);
        },
        onResync,
      );
    } catch (error) {
      await client.close();
      throw error;
    }
    return { close: () => client.close() };
  }

  /**
   * The ORM transaction a publish should be written on: one open on this
   * driver's own connection, matched by name as the queue's database driver
   * matches it. Never on SQLite, where Bun has one connection and a read on
   * the pool runs inside the open transaction: a subscriber would deliver an
   * entry that may still roll back, and whose seq would then be reused. There
   * the manager publishes after the commit instead.
   */
  private transaction(): TransactionSQL | undefined {
    if (this.dialect === "sqlite" || this.connection === undefined) return undefined;
    const tx = currentTransaction();
    if (tx === undefined || currentConnectionName() !== this.connection) return undefined;
    return tx;
  }
}

/** The DDL for both tables, Postgres and SQLite alike. */
export function createTableStatements(heads: string, entries: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS "${heads}" (
    "channel" TEXT NOT NULL PRIMARY KEY,
    "seq" BIGINT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS "${entries}" (
    "channel" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "data" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,
    PRIMARY KEY ("channel", "seq")
)`,
  ];
}
