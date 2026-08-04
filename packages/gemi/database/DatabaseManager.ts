import { SQL } from "bun";
import type { DatabaseConfig } from "./config";
import { MissingDatabaseUrlError, inferDialect, type Dialect } from "./dialect";

// Wraps Bun's `SQL` client. Bun ships one client that speaks SQLite, Postgres,
// MySQL and MariaDB, so gemi does not need a driver per database — it needs to
// know *which* one is in use, which is what `dialect` carries.
//
// Like `RedisManager`, this is safe to build eagerly: Bun's client connects on
// the first query, not at construction. It is still bound as a lazy singleton,
// so an app that never touches the database never resolves it and never has to
// have DATABASE_URL set.
export class DatabaseManager {
  static token = "database";

  public readonly sql: SQL;
  public readonly dialect: Dialect;
  public readonly url: string;

  /**
   * Resolves once the connection has been configured, or rejects if it could
   * not be. Only SQLite has anything to do; elsewhere it is already resolved.
   *
   * Exposed so a caller that needs the guarantee can wait for it. Nothing has
   * to: SQLite queues statements on one connection in the order they were
   * issued, so the pragma below is ahead of anything a caller sends after the
   * constructor returns. That ordering is asserted in `DatabaseManager.test.ts`
   * rather than assumed, because it is the load-bearing half.
   */
  public readonly ready: Promise<void>;

  constructor(public config: DatabaseConfig = {}) {
    const url = config.url;
    if (!url) {
      throw new MissingDatabaseUrlError();
    }

    this.url = url;
    // An explicit `dialect` wins, for URLs whose protocol we can't read (a
    // pooler on a custom scheme). Otherwise infer, which throws rather than
    // guessing — see the note in dialect.ts.
    this.dialect = config.dialect ?? inferDialect(url);
    this.sql = config.options
      ? new SQL(url, config.options as any)
      : new SQL(url);
    this.ready = this.configure();
  }

  /**
   * `pragma foreign_keys = ON`, which SQLite leaves **off** by default — and so
   * does Bun's driver, which reports `0` on a fresh connection.
   *
   * Without it SQLite enforces nothing at all. Not "cascades do not fire":
   * nothing. An insert naming a parent that does not exist is accepted, a
   * dangling reference survives the parent's deletion, and `ON DELETE RESTRICT`
   * does not restrict — while the migrations declare all three. Postgres
   * enforces them always, and Prisma turns the pragma on for every SQLite
   * connection it opens, so leaving it off meant development and production
   * disagreed about whether the schema's constraints were real.
   *
   * It is also why this is more than a dialect gap. The differential harness
   * compares gemi against Prisma on one database per dialect; with the pragma
   * off on one side, the two were being asked to agree while running under
   * different integrity rules, so an entire class of divergence was invisible
   * to the instrument rather than merely untested.
   *
   * **Per connection, not per database**, which is what makes this a live
   * assumption rather than a one-line fix: Bun serves SQLite from a single
   * connection today, so setting it once holds for every later statement. If
   * that ever becomes a pool, one statement's worth of enforcement would move
   * to whichever connection happened to serve it. `DatabaseManager.test.ts`
   * pins both halves — the value, and that it is the same across concurrent
   * queries — so the day it changes is a failing test rather than a silent
   * regression.
   *
   * Issued outside any transaction. SQLite documents the pragma as a no-op
   * inside one, so a lazy "set it on first use" would be correct exactly until
   * the first use happened to be a transaction.
   */
  private async configure(): Promise<void> {
    if (this.dialect !== "sqlite") return;
    await this.sql.unsafe("pragma foreign_keys = ON");
  }

  // Escape hatch matching Bun's own API, so `db.query` reads like `sql` does in
  // Bun's docs: db.query`select * from users where id = ${id}`
  get query(): SQL {
    return this.sql;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
