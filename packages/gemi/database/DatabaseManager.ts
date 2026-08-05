import type { SQL } from "bun";
import type { ConnectionConfig, DatabaseConfig } from "./config";
import {
  Connection,
  DEFAULT_CONNECTION,
  ReservedConnectionNameError,
  UnknownConnectionError,
  type DatabaseConnection,
} from "./Connection";
import type { Dialect } from "./dialect";

// Wraps Bun's `SQL` client. Bun ships one client that speaks SQLite, Postgres,
// MySQL and MariaDB, so gemi does not need a driver per database — it needs to
// know *which* one is in use, which is what `dialect` carries.
//
// Like `RedisManager`, this is safe to build eagerly: Bun's client connects on
// the first query, not at construction. It is still bound as a lazy singleton,
// so an app that never touches the database never resolves it and never has to
// have DATABASE_URL set.
//
// Since #327 it holds *connections*, plural: the top-level `url` and `options`
// build the one called `"default"`, and each key under `connections` builds
// another. What it does not do is decide which one a query uses — that is the
// ORM's ambient scope and the `DB` facade, because the choice is per query
// rather than per application. See `connection` below.
export class DatabaseManager implements DatabaseConnection {
  static token = "database";

  /**
   * This object *is* the default connection, so it answers to the name.
   *
   * Not a formality: `connection("default")` returns `this` rather than the
   * `Connection` in the map, which is what keeps every existing reader —
   * `DB.sql`, `db.dialect`, and the test harnesses that wrap the manager in a
   * Proxy to count statements — looking at the same object the ORM executes
   * through. A second object for the default pool would have quietly bypassed
   * all of them while every test still passed.
   */
  public readonly name = DEFAULT_CONNECTION;

  /**
   * Every pool this manager owns, keyed by name and including the default one.
   *
   * Private because the map is the manager's bookkeeping — `connection()` is
   * the way in, and it is the only path that knows the default is `this`.
   */
  private readonly pools = new Map<string, Connection>();

  /**
   * Resolves once **every** connection has been configured, or rejects if one
   * could not be. Only SQLite has anything to do; elsewhere it is already
   * resolved.
   *
   * All of them rather than the default alone, because the thing a caller waits
   * on this for — SQLite's `pragma foreign_keys` — is per client, so a second
   * SQLite connection has its own and a caller awaiting one manager-level
   * promise means all of them.
   */
  public readonly ready: Promise<void>;

  constructor(public config: DatabaseConfig = {}) {
    const { connections = {}, ...primary } = config;

    // The default first, so a `MissingDatabaseUrlError` from a missing
    // `DATABASE_URL` still comes out of construction the way it always has,
    // rather than after a named connection has already opened a client.
    this.pools.set(
      DEFAULT_CONNECTION,
      new Connection(DEFAULT_CONNECTION, primary),
    );

    // A connection that is built before the one whose config is wrong is still
    // a live client with an open handle, and on the throwing path nothing else
    // will ever hold it: the manager never becomes a value, so nobody can call
    // `close`. Left alone, the pragma this constructor issues for a SQLite
    // connection settles against a client being torn down and surfaces as an
    // unhandled rejection with no configuration error anywhere near it.
    try {
      this.build(connections, primary.slowTransactionThreshold);
    } catch (error) {
      for (const pool of this.pools.values()) {
        // The in-flight configuration first: it is what rejects when the client
        // under it goes away, and this is the only place that can say the
        // rejection was expected.
        pool.ready.catch(() => {});
        pool.close().catch(() => {});
      }
      throw error;
    }

    // Built once here rather than derived per read, so that a connection whose
    // configuration rejects produces one unhandled rejection at most instead of
    // a fresh one per access.
    this.ready = Promise.all(
      [...this.pools.values()].map((pool) => pool.ready),
    ).then(() => undefined);
  }

  private build(
    connections: Record<string, ConnectionConfig>,
    slowTransactionThreshold: number | false | undefined,
  ): void {
    for (const [name, connection] of Object.entries(connections)) {
      if (name === DEFAULT_CONNECTION)
        throw new ReservedConnectionNameError(name);

      this.pools.set(
        name,
        new Connection(name, {
          // The threshold is the one setting a named connection is likely to
          // want *unchanged*: it is a development diagnostic about holding a
          // pooled connection, and that concern does not stop applying because
          // the pool has a name. `url`, `options` and `dialect` are deliberately
          // not inherited — a connection that borrowed the default's URL by
          // omission would be a second pool onto the same database created by a
          // typo in a key.
          slowTransactionThreshold,
          ...connection,
        }),
      );
    }
  }

  /**
   * The connection called `name`, or the default one when called with nothing.
   *
   * Throws rather than falling back to the default for an unknown name, and
   * that is the important half. A fallback would make `Model.on("analitycs")`
   * run on the hot path — the exact pool the caller was trying to stay off —
   * and the only symptom would be the incident it was meant to prevent,
   * arriving weeks later with nothing pointing back at the typo.
   */
  connection(name: string = DEFAULT_CONNECTION): DatabaseConnection {
    // `this`, not `pools.get(DEFAULT_CONNECTION)` — see `name` above.
    if (name === DEFAULT_CONNECTION) return this;

    const found = this.pools.get(name);
    if (!found) throw new UnknownConnectionError(name, this.connectionNames);
    return found;
  }

  /** Every configured name, default first. For error messages and diagnostics. */
  get connectionNames(): string[] {
    return [...this.pools.keys()];
  }

  /**
   * The default connection's client. Unchanged in meaning: an application that
   * never names a connection sees exactly what it saw before #327.
   */
  get sql(): SQL {
    return this.default.sql;
  }

  get dialect(): Dialect {
    return this.default.dialect;
  }

  get url(): string {
    return this.default.url;
  }

  // Escape hatch matching Bun's own API, so `db.query` reads like `sql` does in
  // Bun's docs: db.query`select * from users where id = ${id}`
  get query(): SQL {
    return this.sql;
  }

  /** Closes every connection, not only the default one. */
  async close(): Promise<void> {
    // The aggregate promise needs the same treatment each connection's own
    // `ready` gets in `Connection.close` — it is derived from them, so a
    // rejection there arrives here as a second, separately unhandled one.
    this.ready.catch(() => {});
    await Promise.all([...this.pools.values()].map((pool) => pool.close()));
  }

  private get default(): Connection {
    return this.pools.get(DEFAULT_CONNECTION)!;
  }
}
