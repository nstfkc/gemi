import type { SQL } from "bun";
import { DatabaseManager } from "../database/DatabaseManager";
import type { Dialect } from "../database/dialect";
import { Facade } from "./Facade";

// Access to the app's database connection. Bun's `SQL` client is a tagged
// template, so queries read the same here as they do in Bun's own docs:
//
//   const users = await DB.sql`select * from users where id = ${id}`
//
// Values interpolated into the template are bound as parameters, not
// concatenated into the SQL string — `${id}` is a placeholder, so this is not a
// SQL injection risk.
export class DB extends Facade {
  static getFacadeAccessor() {
    return DatabaseManager;
  }

  // The Bun `SQL` client. Tagged-template queries go through here.
  static get sql(): SQL {
    return this.getFacadeRoot().sql;
  }

  // Which database is in use, inferred from the connection URL. Read this when
  // generating SQL that differs across databases (upserts, `RETURNING`,
  // autoincrement, boolean and timestamp types).
  static get dialect(): Dialect {
    return this.getFacadeRoot().dialect;
  }

  // Runs the callback inside a transaction, committing when it resolves and
  // rolling back if it throws.
  static transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    return this.sql.begin(fn as any) as Promise<T>;
  }

  static close(): Promise<void> {
    return this.getFacadeRoot().close();
  }
}
