import type { SQL } from "bun";
import { DatabaseManager } from "../database/DatabaseManager";
import type { Dialect } from "../database/dialect";
import { withTransaction } from "../orm/context";
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
  // rolling back if it throws. The callback still receives the raw handle, as
  // it always has.
  //
  // It goes through the ORM's `withTransaction` rather than straight to
  // `sql.begin` so that the two transaction systems are one: a `User.create`
  // inside a `DB.transaction` joins it instead of committing separately on a
  // pooled connection, and a `DB.transaction` nested inside a
  // `Model.transaction` becomes a savepoint instead of throwing (Bun refuses
  // `begin` inside a transaction). Two systems that silently ignored each other
  // would be worse than either alone — a rollback would leave half the work
  // committed.
  //
  // The slow-transaction threshold comes from the same `database` config as it
  // does for the ORM, so a `DB.transaction` holding a connection too long warns
  // exactly as a `Model.transaction` would. Same reason as above: one system.
  static transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    const db = this.getFacadeRoot();
    return withTransaction(db.sql, fn as (tx: SQL) => Promise<T>, {
      slowTransactionThreshold: db.config.slowTransactionThreshold,
    });
  }

  static close(): Promise<void> {
    return this.getFacadeRoot().close();
  }
}
