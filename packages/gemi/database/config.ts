import type { SQL } from "bun";
import type { Dialect } from "./dialect";

// One connection: a URL, the dialect to compile for, and the pool behind it.
//
// Split out of `DatabaseConfig` when a second connection became configurable
// (#327), so that a named connection is described by exactly the same fields
// the default one is — rather than by a smaller, second-class shape that would
// need widening the first time somebody's analytics pool needed a `dialect`
// override or a threshold of its own.
export interface ConnectionConfig {
  // Connection string. Defaults to the `DATABASE_URL` environment variable.
  // The dialect is inferred from it — `postgres://`, `mysql://`, `mariadb://`,
  // `sqlite://`, `file:`, or a SQLite path like `./dev.db` or `:memory:`.
  url?: string;

  // Override the inferred dialect. Only needed when the URL doesn't carry a
  // recognisable protocol — a proxy or connection pooler fronting Postgres on a
  // custom scheme, say. Wrong values here produce SQL that fails at runtime
  // against a database that connected fine, so leave it unset unless inference
  // actually gets it wrong.
  dialect?: Dialect;

  // Options passed straight through to Bun's `SQL` client (pool size, timeouts,
  // TLS, ...). See https://bun.sh/docs/api/sql.
  options?: Record<string, unknown>;

  // How long a transaction may run, in milliseconds, before development warns
  // that it is still holding a pooled connection. `false` turns the warning off.
  //
  // A diagnostic, not a limit: nothing here cancels or shortens a transaction.
  // It only fires in development — the cost of a long transaction is paid by
  // unrelated queries blocking on connection acquisition, and that is a problem
  // worth catching while the callback is still in front of you.
  //
  // Raise it for a seed script or a data migration whose transactions are
  // legitimately long; `false` if the noise is not worth it at all. A value
  // that is not a positive finite number falls back to the 2s default rather
  // than disabling, so the warning cannot be lost to a typo — say `false` when
  // you mean off.
  //
  // Per connection, and this is the field most likely to differ between two of
  // them: a connection that exists *because* its queries are slow will warn on
  // every transaction it opens if it inherits the hot path's threshold, and a
  // warning that always fires is one nobody reads. A named connection that
  // does not set it inherits the top-level value.
  slowTransactionThreshold?: number | false;
}

// Config key: `database`.
//
// The top-level `url` / `options` / `dialect` describe the connection called
// `"default"` — the one every query uses unless it says otherwise. `connections`
// declares the others.
export interface DatabaseConfig extends ConnectionConfig {
  // Additional connections, keyed by the name `DB.connection(name)` and
  // `Model.on(name)` take.
  //
  // The case this exists for is two pools against **one** database with
  // opposite workloads — a hot path that must never block, and an analytics
  // path whose queries legitimately run for seconds:
  //
  //     export default defineDatabaseConfig({
  //       url: process.env.DATABASE_URL,
  //       options: { max: 12 },
  //
  //       connections: {
  //         analytics: {
  //           url: process.env.DATABASE_URL,
  //           options: { max: 3, idleTimeout: 60, connectionTimeout: 45 },
  //           slowTransactionThreshold: 60_000,
  //         },
  //       },
  //     })
  //
  // A value that protects one of those is the wrong value for the other, which
  // is the entire reason they cannot be one pool with one setting. The same URL
  // twice is normal here and is not a mistake: what differs is the pool, not
  // the database.
  //
  // Two consequences worth knowing before declaring one, both of them
  // structural rather than incidental:
  //
  // - **A transaction cannot span two connections.** A statement that names one
  //   while a transaction is open on another raises
  //   `CrossConnectionTransactionError` rather than quietly running outside the
  //   transaction.
  // - **Every connection is a real pool**, counted separately against whatever
  //   connection cap the server or the pooler enforces. Two pools of 12 is 24
  //   connections, not 12.
  connections?: Record<string, ConnectionConfig>;
}

export function defineDatabaseConfig(config: DatabaseConfig): DatabaseConfig {
  return config;
}

export function databaseConfigDefaults(): DatabaseConfig {
  return {
    url: process.env.DATABASE_URL,
    dialect: undefined,
    options: undefined,
    slowTransactionThreshold: SLOW_TRANSACTION_THRESHOLD,
    connections: undefined,
  };
}

// The default warning threshold, in milliseconds. Exported so the ORM can fall
// back to the same number when a `DatabaseManager` was built without going
// through `withDefaults` — a test constructing one directly, say — rather than
// keeping a second copy of it that can drift.
export const SLOW_TRANSACTION_THRESHOLD = 2_000;

export type { SQL };
