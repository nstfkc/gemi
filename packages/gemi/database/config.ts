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
}

export function defineDatabaseConfig(config: DatabaseConfig): DatabaseConfig {
  return config;
}

export function databaseConfigDefaults(): DatabaseConfig {
  return {
    url: process.env.DATABASE_URL,
    dialect: undefined,
    options: undefined,
  };
}

export type { SQL };
