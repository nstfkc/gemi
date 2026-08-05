import { SQL } from "bun";
import type { ConnectionConfig } from "./config";
import { MissingDatabaseUrlError, inferDialect, type Dialect } from "./dialect";

/**
 * The name of the connection an application gets without asking for one: the
 * `url` / `options` pair at the top level of `app/config/database.ts`.
 *
 * A constant rather than the string spelled at each site, because it is
 * compared in five places across three layers — the manager resolving a name,
 * the ORM deciding whether a query names a different pool than the open
 * transaction, and the facade — and a typo in any one of them reads as "that
 * connection is not configured" rather than as a typo.
 */
export const DEFAULT_CONNECTION = "default";

/**
 * What every layer above `database/` is allowed to know about a connection.
 *
 * `DatabaseManager` implements this itself and *is* the default connection —
 * see the note on `DatabaseManager.connection`. So this interface is the one
 * shape the ORM and the `DB` facade read, whether they are looking at the
 * default pool or at a named one, and neither has to branch on which it got.
 */
export interface DatabaseConnection {
  /** `"default"`, or the key this connection was declared under. */
  readonly name: string;
  readonly url: string;
  readonly dialect: Dialect;
  readonly sql: SQL;
  readonly ready: Promise<void>;
  readonly config: ConnectionConfig;
}

/** A connection named in the config that the manager has no pool for. */
export class UnknownConnectionError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `No database connection named "${name}". Configured: ` +
        `${known.map((one) => `"${one}"`).join(", ")}. Declare it under ` +
        `\`connections\` in app/config/database.ts.`,
    );
    this.name = "UnknownConnectionError";
  }
}

/**
 * A `connections` entry that would shadow the top-level `url`.
 *
 * Refused rather than merged, because the two spellings would be a silent
 * either/or: whichever the manager happened to build last would win, and the
 * losing half of the config would go on describing a pool nothing uses.
 */
export class ReservedConnectionNameError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is the name of the connection declared by the top-level ` +
        `\`url\` and \`options\`, so it cannot also appear under ` +
        `\`connections\`. Rename it, or move its settings up to the top level.`,
    );
    this.name = "ReservedConnectionNameError";
  }
}

/**
 * A statement that named one connection while a transaction was open on
 * another.
 *
 * **The whole reason named connections refuse rather than route.** A
 * transaction lives on one reserved connection of one pool; there is no
 * mechanism by which a second pool's statement could join it, and no rollback
 * that could take it back. So the alternatives to this error are both worse
 * than an error:
 *
 * - Run it on the other pool anyway, *outside* the transaction. The caller
 *   wrote `Model.transaction`, the block rolls back, and that one statement
 *   stays committed. Half the work landed and nothing said so.
 * - Run it on the open handle, ignoring the name. Then the statement went to
 *   the wrong database, which the ORM cannot even detect afterwards — the
 *   tables are usually the same shape.
 *
 * There is no third answer at this layer; two-phase commit is not what a second
 * pool for analytics is asking for. So the failure is made loud and early, at
 * the call that would have straddled the two, and the fix is always the same
 * shape: move that query outside the transaction, or do the whole unit on one
 * connection.
 */
export class CrossConnectionTransactionError extends Error {
  constructor(
    /** The connection the open transaction belongs to. */
    public readonly open: string,
    /** The connection the refused statement named. */
    public readonly requested: string,
  ) {
    super(
      `A transaction is open on the "${open}" connection, and this statement ` +
        `names "${requested}". A transaction cannot span two connections: ` +
        `the statement would run outside it and stay committed when the ` +
        `transaction rolls back. Move this query outside the transaction, or ` +
        `run the whole unit on one connection.`,
    );
    this.name = "CrossConnectionTransactionError";
  }
}

/**
 * One pool: a URL, its dialect, and Bun's client for it.
 *
 * Extracted from `DatabaseManager` when a second connection became
 * configurable (#327). The manager kept the lifecycle — which names exist, how
 * they are resolved, closing them all — and this kept everything that is true
 * of a connection *one at a time*, so the two do not have to be written twice.
 *
 * Safe to build eagerly, like the manager it came from: Bun's client connects
 * on the first query, not at construction. A named connection an application
 * declares and never queries therefore costs an object.
 */
export class Connection implements DatabaseConnection {
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

  constructor(
    public readonly name: string,
    public readonly config: ConnectionConfig = {},
  ) {
    const url = config.url;
    if (!url) {
      throw new MissingDatabaseUrlError(name);
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
   * That per-connection wording is now literal in a second sense: a named
   * SQLite connection is a *different* Bun client, so it needs the pragma of
   * its own. Running it from this constructor is what makes that automatic —
   * the alternative, doing it once for the default connection, was correct
   * exactly while there was only one.
   *
   * Issued outside any transaction. SQLite documents the pragma as a no-op
   * inside one, so a lazy "set it on first use" would be correct exactly until
   * the first use happened to be a transaction.
   */
  private async configure(): Promise<void> {
    if (this.dialect !== "sqlite") return;
    await this.sql.unsafe("pragma foreign_keys = ON");
  }

  // Escape hatch matching Bun's own API, so `connection.query` reads like `sql`
  // does in Bun's docs: connection.query`select * from users where id = ${id}`
  get query(): SQL {
    return this.sql;
  }

  async close(): Promise<void> {
    // A close that races the constructor's `pragma` leaves that statement to
    // settle against a client that is going away, and it settles as a rejection
    // — `ERR_SQLITE_CONNECTION_CLOSED`, from a promise nobody is holding, which
    // arrives as an unhandled rejection naming neither the close nor the
    // pragma. The caller asked for this connection to go away, so that
    // rejection is expected rather than something to surface. Marked handled
    // here rather than suppressed globally, and only on the way out.
    this.ready.catch(() => {});
    await this.sql.close();
  }
}
