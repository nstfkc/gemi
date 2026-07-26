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
