import type { SQL } from "bun";
import { DatabaseManager } from "../database/DatabaseManager";
import type { Dialect } from "../database/dialect";
import { currentTransaction, withTransaction } from "../orm/context";
import { dialectFor } from "../orm/dialect";
import { renderFragment, type SqlFragment } from "../orm/sql";
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

  // Runs a composed fragment and returns its rows.
  //
  //   const where = filters.length ? sql`where ${join(filters, " and ")}` : empty
  //   const rows = await DB.query(sql`select * from "Product" ${where}`)
  //
  // Two things it does that `DB.sql` does not, and they are the reason it
  // exists rather than being sugar:
  //
  // - It takes a **fragment**, so a predicate can be built as a value and
  //   passed around. See `orm/sql.ts` for why that shape is the one raw SQL
  //   actually needs.
  // - It runs on the **ambient transaction** when there is one. A raw statement
  //   that quietly escapes `Model.transaction` and commits while its neighbours
  //   roll back is worse than no raw statement at all — so this resolves the
  //   handle exactly as `Model.$exec` does, through `currentTransaction()`.
  //
  // A plain string is refused. That is deliberate: accepting one would make an
  // interpolated template the path of least resistance, which is the injection
  // this whole mechanism exists to keep closed. `unsafeSql` is the door, and it
  // is named so that using it is a decision.
  //
  // `async` rather than returning the driver's promise directly, so that a
  // rejected fragment — a plain string, a parameter count over the ceiling —
  // *rejects* instead of throwing synchronously. An API that does one sometimes
  // and the other otherwise is a footgun: `DB.query(...).catch(…)` would miss
  // exactly the errors this refuses to run.
  static async query<T = any>(fragment: SqlFragment): Promise<T[]> {
    return (await this.run(fragment, "query")) as T[];
  }

  // The same, for a statement whose answer is *how many rows it touched*.
  //
  //   const won = await DB.execute(
  //     sql`update "Reservation" set status = 'claimed'
  //         where id = ${id} and status = 'reserved'`,
  //   )
  //   if (won === 0) { /* somebody else claimed it first */ }
  //
  // The count is the concurrency primitive there, not a diagnostic: 1 means this
  // caller won the compare-and-swap and 0 means it lost, and an API that
  // discarded it could not express that at all.
  //
  // **Where the number comes from.** Bun puts it on `count`, and leaves
  // `affectedRows` null — measured on both dialects rather than read from a
  // changelog, for `update`, `delete`, `insert`, a statement matching nothing,
  // and one with `returning`.
  //
  // `result.count` on what is otherwise an *array* reads like a bug, so: Bun
  // returns an array with `count`, `command` and `lastInsertRowid` hung off it,
  // on every statement including the ones that return no rows at all. A write
  // without `returning` is therefore a zero-length array whose `count` is the
  // number of rows it touched, and a write *with* one is an array of the rows
  // whose `count` matches their number. `compile/write.ts` records the same measurement
  // from the other side: the *ORM's* counts come from `RETURNING` instead,
  // because there the statement shape is ours to choose and an exact count that
  // depends on nothing undocumented is worth a key column per row. Here the
  // statement is the caller's, so there is nothing to add a `RETURNING` to.
  static async execute(fragment: SqlFragment): Promise<number> {
    const result = await this.run(fragment, "execute");
    return Number((result as { count?: unknown })?.count ?? 0);
  }

  private static run(fragment: SqlFragment, operation: string) {
    const db = this.getFacadeRoot();
    // Per call, never captured: the same rule `Model.$exec` follows, and what
    // keeps the connection swappable in tests.
    const { text, values } = renderFragment(
      fragment,
      dialectFor(db.dialect),
      operation,
    );
    return (currentTransaction() ?? db.sql).unsafe(text, values);
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
