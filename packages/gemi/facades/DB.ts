import type { SQL } from "bun";
import type { DatabaseConnection } from "../database/Connection";
import { DatabaseManager } from "../database/DatabaseManager";
import type { Dialect } from "../database/dialect";
import { app } from "../foundation/app";
import {
  assertConnectionUsable,
  currentConnectionName,
  currentTransaction,
  runOnConnection,
  withTransaction,
} from "../orm/context";
import { dialectFor } from "../orm/dialect";
import { renderFragment, type SqlFragment } from "../orm/sql";
import { Facade } from "./Facade";

/**
 * The raw-SQL surface, pointed at one connection.
 *
 * `DB` itself is one of these — the one that resolves the **ambient**
 * connection per call — and `DB.connection(name)` returns one bound to a name.
 * Written once rather than twice so the two cannot drift: a fragment run
 * through a named connection has to reach the driver by exactly the path
 * `DB.query` does, or the ambient transaction, the placeholder numbering and
 * the string refusal would each be a thing that works on one of them.
 *
 * Every method resolves the manager, the connection and the dialect **per
 * call** and captures none of them, which is the rule `Model.$exec` follows and
 * what keeps the connection swappable in tests.
 */
export class ConnectionQueries {
  /**
   * `undefined` means *whichever connection is ambient*, which is the default
   * one unless an enclosing transaction or `Model.on` named another. That is
   * the mode `DB`'s own statics use, and it is why an unqualified `DB.query`
   * inside `DB.connection("analytics").transaction(...)` joins that transaction
   * instead of being refused by it.
   */
  constructor(private readonly bound?: string) {}

  /** The name this handle will use for the call happening now. */
  get name(): string {
    return this.bound ?? currentConnectionName();
  }

  /** The Bun `SQL` client. Tagged-template queries go through here. */
  get sql(): SQL {
    return this.connection().sql;
  }

  /**
   * Which database is in use, inferred from the connection URL. Read this when
   * generating SQL that differs across databases (upserts, `RETURNING`,
   * autoincrement, boolean and timestamp types).
   */
  get dialect(): Dialect {
    return this.connection().dialect;
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
  async query<T = any>(fragment: SqlFragment): Promise<T[]> {
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
  async execute(fragment: SqlFragment): Promise<number> {
    const result = await this.run(fragment, "execute");
    return Number((result as { count?: unknown })?.count ?? 0);
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
  //
  // On a named connection the whole callback runs with that connection ambient,
  // so a `User.create` inside `DB.connection("analytics").transaction(...)`
  // joins the transaction rather than opening a second one on the hot path.
  //
  // `async` so that a handle used inside a transaction on another connection
  // *rejects* rather than throwing synchronously — the same reason `query`
  // above is, and the same `.catch()` that would otherwise miss it.
  async transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    const name = this.name;
    const connection = this.connection(name);

    return withTransaction(
      connection.sql,
      (tx) => runOnConnection(name, () => fn(tx)),
      {
        slowTransactionThreshold: connection.config.slowTransactionThreshold,
        connection: name,
      },
    );
  }

  private run(fragment: SqlFragment, operation: string) {
    const db = this.connection();
    // Per call, never captured: the same rule `Model.$exec` follows, and what
    // keeps the connection swappable in tests.
    const { text, values } = renderFragment(
      fragment,
      dialectFor(db.dialect),
      operation,
    );
    return (this.handle() ?? db.sql).unsafe(text, values);
  }

  /**
   * The open transaction, but only when it belongs to this handle's connection.
   *
   * `assertConnectionUsable` has already refused the case where they differ, so
   * reaching this with a mismatch is impossible — except for the unqualified
   * handle, whose name *is* the transaction's. The comparison is kept anyway
   * because it is what makes that reasoning local: nothing here has to know
   * which caller checked what.
   */
  private handle() {
    const tx = currentTransaction();
    if (tx === undefined) return undefined;
    return currentConnectionName() === this.name ? tx : undefined;
  }

  private connection(name = this.name): DatabaseConnection {
    assertConnectionUsable(name);
    return app(DatabaseManager).connection(name);
  }
}

/**
 * The handles `DB.connection` has already built.
 *
 * A handle holds a name and nothing else — it resolves the manager per call —
 * so one per name is enough, and reusing them keeps `DB.connection("analytics")`
 * free to be written inline in a hot path.
 */
const handles = new Map<string, ConnectionQueries>();

/** The unqualified handle: whichever connection is ambient, per call. */
const ambient = new ConnectionQueries();

// Access to the app's database connections. Bun's `SQL` client is a tagged
// template, so queries read the same here as they do in Bun's own docs:
//
//   const users = await DB.sql`select * from users where id = ${id}`
//
// Values interpolated into the template are bound as parameters, not
// concatenated into the SQL string — `${id}` is a placeholder, so this is not a
// SQL injection risk.
//
// Every static here works on the **ambient** connection: the default one,
// unless an enclosing `DB.connection(name).transaction(...)` named another.
// `DB.connection(name)` is the way to name one explicitly.
export class DB extends Facade {
  static getFacadeAccessor() {
    return DatabaseManager;
  }

  /**
   * The raw-SQL surface for a named connection.
   *
   *     const rows = await DB.connection("analytics").query(sql`…`)
   *     await DB.connection("analytics").transaction(async () => { … })
   *
   * The names are the keys of `connections` in `app/config/database.ts`, plus
   * `"default"` for the top-level `url`. An unknown one raises
   * `UnknownConnectionError` when the handle is used, listing what is
   * configured — never a silent fall back to the default, which would put the
   * query on precisely the pool the caller was trying to stay off.
   *
   * A transaction cannot span two connections. Using a named handle while a
   * transaction is open on another connection raises
   * `CrossConnectionTransactionError` rather than running the statement outside
   * that transaction, where it would survive the rollback.
   */
  static connection(name: string): ConnectionQueries {
    let handle = handles.get(name);
    if (handle === undefined) handles.set(name, (handle = new ConnectionQueries(name)));
    return handle;
  }

  // The Bun `SQL` client. Tagged-template queries go through here.
  static get sql(): SQL {
    return ambient.sql;
  }

  // Which database is in use, inferred from the connection URL. Read this when
  // generating SQL that differs across databases (upserts, `RETURNING`,
  // autoincrement, boolean and timestamp types).
  static get dialect(): Dialect {
    return ambient.dialect;
  }

  // Runs a composed fragment and returns its rows, on the ambient transaction
  // when there is one. See `ConnectionQueries.query`, which is the whole of it.
  static query<T = any>(fragment: SqlFragment): Promise<T[]> {
    return ambient.query<T>(fragment);
  }

  // The same, for a statement whose answer is *how many rows it touched* — the
  // compare-and-swap primitive. See `ConnectionQueries.execute`.
  static execute(fragment: SqlFragment): Promise<number> {
    return ambient.execute(fragment);
  }

  // Runs the callback inside a transaction, committing when it resolves and
  // rolling back if it throws. One transaction system with the ORM's, so a
  // `User.create` inside this joins it. See `ConnectionQueries.transaction`.
  static transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    return ambient.transaction(fn);
  }

  /** Closes every configured connection, not only the default one. */
  static close(): Promise<void> {
    return this.getFacadeRoot().close();
  }
}
