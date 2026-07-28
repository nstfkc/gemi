import type { SQL } from "bun";
import type { Dialect } from "./dialect";

// Config key: `database`.
export interface DatabaseConfig {
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
  slowTransactionThreshold?: number | false;
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
  };
}

// The default warning threshold, in milliseconds. Exported so the ORM can fall
// back to the same number when a `DatabaseManager` was built without going
// through `withDefaults` — a test constructing one directly, say — rather than
// keeping a second copy of it that can drift.
export const SLOW_TRANSACTION_THRESHOLD = 2_000;

export type { SQL };
