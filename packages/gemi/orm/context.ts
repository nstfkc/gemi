import type { SQL, TransactionSQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { SLOW_TRANSACTION_THRESHOLD } from "../database/config";
import {
  CrossConnectionTransactionError,
  DEFAULT_CONNECTION,
} from "../database/Connection";

/**
 * The ambient transaction: the ORM's own `AsyncLocalStorage`, holding nothing
 * but the open handle and how deep the nesting is.
 *
 * One store per scope with one owner, which is the pattern the framework
 * already follows — `kernel/context.ts` holds the Application,
 * `http/requestContext.ts` the request and its user,
 * `services/pubsub/BroadcastManager.ts` a socket's headers. The reasoning for
 * not folding this into the kernel's is written up beside it, and the short
 * version is that a transaction scope has to *nest inside* an Application scope
 * without replacing it, and `foundation/app.ts` must keep reading exactly one
 * shape out of the kernel store or resolving a service becomes a transaction
 * concern.
 *
 * What makes an ALS the right home rather than a field somewhere: two concurrent
 * requests each in their own transaction must never see each other's handle.
 * Anything reachable from the Application — which is one object shared by every
 * in-flight request — fails that by construction, and fails it as silently
 * written data, not as an error. "two concurrent transactions never see each
 * other's handle" in `context.test.ts` is the test that would catch it.
 */
export interface OrmScope {
  /**
   * Bun's transaction handle. Every ORM statement in scope runs on it, which
   * means they all run on one reserved connection — so nothing here may issue
   * two statements concurrently. `Model.$exec` already runs its nested writes
   * and its relation reads sequentially, for exactly this reason.
   */
  tx?: TransactionSQL;
  /** 0 for the outermost transaction, 1+ for each savepoint inside it. */
  depth: number;
  /**
   * Which named connection this subtree's queries run on, and — when `tx` is
   * set — which connection the open transaction belongs to.
   *
   * Ambient rather than an argument threaded through `$exec`, for the same
   * reason the handle above is: a relation read resolves its target through the
   * registry and calls that class's `$exec`, so an argument would have to be
   * carried by every intermediate that has no interest in it, and the one that
   * forgot would silently read a nested `include` off the *other* pool. There
   * is no error that shape produces; there are just rows from the wrong place.
   *
   * `undefined` means the default connection. Kept as absent-rather-than-
   * `"default"` so that entering a scope on the default connection is
   * indistinguishable from not entering one, which is what makes the
   * cross-connection check below cost a comparison of two `undefined`s on every
   * application that never declares a second connection.
   */
  connection?: string;
  /**
   * Whether policies are suspended for this scope. Set only by
   * `Model.asSystem`, and never by anything ambient — the whole point is that
   * unscoped access is a decision visible at the call site, not the accidental
   * result of a missing user.
   */
  system?: boolean;
  /**
   * The user policies should scope to, when there is no request to read one
   * from. Set only by `Model.asUser`.
   *
   * A sentinel wrapper rather than the bare value, so that "a scope was entered
   * with `null`" stays distinguishable from "no scope was entered" — the two
   * mean different things under deny-by-default.
   */
  actor?: { user: unknown };
}

/**
 * One ambient scope for the ORM, not one per feature.
 *
 * Transactions (iteration 5) and system access (iteration 6) are both
 * "something is true for this async subtree and every query in it", so they
 * share a store rather than minting a second `AsyncLocalStorage` each. The
 * inventory note in `kernel/context.ts` sets the bar for adding one; two
 * booleans-worth of ORM state does not clear it.
 */
export const ormContext = new AsyncLocalStorage<OrmScope>();

/**
 * The open transaction, or `undefined` outside one. This is what `Model.$exec`
 * consults to decide which connection a statement runs on.
 *
 * Exported as the escape hatch for code that genuinely needs the handle — a raw
 * query that must join the surrounding transaction, say. **Do not store what it
 * returns.** Bun's handle stays callable after its `begin` resolves: queries on
 * it then run on the pooled connection, outside any transaction, and succeed.
 * Verified against both dialects, and it is the reason `Model.transaction`'s
 * callback takes no argument.
 */
export function currentTransaction(): TransactionSQL | undefined {
  return ormContext.getStore()?.tx;
}

/**
 * The connection every query in this scope runs on unless it names another.
 *
 * `"default"` outside any scope, so callers get a name rather than a
 * `string | undefined` to normalise themselves — the store keeps it absent,
 * which is not the same distinction and is nobody else's business.
 */
export function currentConnectionName(): string {
  return ormContext.getStore()?.connection ?? DEFAULT_CONNECTION;
}

/**
 * Run `fn` with `name` as the ambient connection.
 *
 * Merged into the current scope rather than replacing it, exactly as
 * `runAsSystem` and `runAsUser` are: naming a connection must not drop an open
 * transaction handle or re-enable policies underneath it.
 *
 * Deliberately absent from `orm/index.ts`, so it is not part of what an
 * application can reach — `Model.on(name)` and `DB.connection(name)` are the
 * two doors, and both funnel through here so that a nested relation read,
 * which resolves its own class out of the registry and calls its `$exec`,
 * inherits the connection without anything having to pass it along.
 */
export function runOnConnection<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = ormContext.getStore();
  if (currentConnectionName() === name) return fn();

  // ENTERING A CONNECTION IS WHERE THE CROSS-CONNECTION CHECK BELONGS, not at
  // each door — and it has to be *here*, before the scope is entered, because
  // entering it is what makes the check impossible afterwards.
  //
  // The scope carries `tx` and `connection` together, so overwriting the name
  // while an open handle stays in place produces a store that says "a
  // transaction on analytics" while holding the *default* connection's handle.
  // Every check downstream then agrees with itself and the statement runs on
  // the wrong connection's transaction. `Model.save` found this: it routes to
  // the row's own connection, so it is the one caller that switches connections
  // with a transaction already open.
  assertConnectionUsable(name);

  return ormContext.run(
    {
      ...current,
      depth: current?.depth ?? 0,
      connection: name === DEFAULT_CONNECTION ? undefined : name,
    },
    fn,
  );
}

/**
 * Refuse a statement that names one connection while a transaction is open on
 * another.
 *
 * The check `withTransaction`'s single-connection note asked for, and the
 * reasoning for refusing rather than routing is on
 * `CrossConnectionTransactionError`. Both doors call it — `Model.$exec` for
 * every model operation, `DB` for a raw fragment — because either one alone
 * leaves the other free to straddle the two connections, and a raw `DB.execute`
 * escaping a transaction is the more damaging of the two.
 *
 * Only ever fires on a query that *names* a connection: an unqualified one
 * resolves to the ambient name, which is the transaction's own.
 */
export function assertConnectionUsable(name: string): void {
  const store = ormContext.getStore();
  if (store?.tx === undefined) return;

  const open = store.connection ?? DEFAULT_CONNECTION;
  if (open === name) return;

  throw new CrossConnectionTransactionError(open, name);
}

/** How deeply nested the current transaction is; `null` outside one. */
export function transactionDepth(): number | null {
  const store = ormContext.getStore();
  return store?.tx === undefined ? null : store.depth;
}

/** Whether policies are suspended for the current async scope. */
export function isSystemScope(): boolean {
  return ormContext.getStore()?.system === true;
}

/**
 * Run `fn` with policies suspended.
 *
 * The escape hatch the deny-by-default rule needs to be usable: a cron tick, a
 * queue worker or a seed script has no user, and under deny-by-default every
 * policied model would refuse it. This makes that intent explicit *at the call
 * site*, which is the property that matters — unscoped access must never be
 * what happens when a user simply fails to turn up.
 *
 * It nests inside a transaction and a transaction nests inside it: the scope is
 * merged rather than replaced, so `asSystem` does not silently drop an open
 * handle.
 */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  const current = ormContext.getStore();
  return ormContext.run({ ...current, depth: current?.depth ?? 0, system: true }, fn);
}

/** The explicitly-set actor, or `undefined` when none was. */
export function currentActor(): { user: unknown } | undefined {
  return ormContext.getStore()?.actor;
}

/**
 * Run `fn` with policies scoped to `user`, for code with no request to read one
 * from.
 *
 * The counterpart to `runAsSystem`, and the reason that one is not the only
 * escape hatch. A queue worker processing "send the invoice for organisation 7"
 * genuinely acts *as somebody*; giving it `asSystem` would suspend policies
 * entirely and leave it hand-scoping every query — which is precisely the
 * unscoped-by-accident failure the deny-by-default rule exists to prevent. The
 * narrow tool should be the easy one.
 *
 * It is also what makes policies testable without reaching into
 * `RequestContext`'s internals.
 *
 * Takes precedence over the request store, so a job that says who it is acting
 * as is not quietly overridden by an ambient request that happens to enclose it.
 *
 * It also **clears `system`**, which is the more surprising half. Acting as a
 * user is strictly narrower than acting as the system, so naming one inside an
 * `asSystem` block has to narrow back — and the spread would otherwise carry
 * `system: true` forward, leaving `$exec` to skip policies entirely while
 * `currentUser()` cheerfully returned the actor. Silently unscoped, from the
 * realistic shape: a worker enters `asSystem` to read its job queue, then
 * narrows to the job's owner for the work itself. The reverse nesting —
 * `asSystem` inside `asUser` — suspends policies, which is what it should do.
 */
export function runAsUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  const current = ormContext.getStore();
  return ormContext.run(
    {
      ...current,
      depth: current?.depth ?? 0,
      system: false,
      actor: { user: user ?? null },
    },
    fn,
  );
}

/**
 * The warning threshold in milliseconds, or `null` when the warning is off.
 *
 * `configured` is `database.slowTransactionThreshold` — see `DatabaseConfig`.
 * It arrives as a value rather than being read from here so that this file
 * keeps knowing nothing about the container: `withTransaction` is reachable
 * with a bare pool, and its tests use one.
 *
 * Exported for its own tests. The behaviour worth pinning is the fallback —
 * that a malformed threshold lands on the default rather than disabling — and
 * that cannot be observed through `withTransaction`: "no warning fired" is what
 * a disabled warning looks like too, so a behavioural test of it passes just as
 * happily when the fallback is gone. Asserting the number directly is the only
 * form of that test that can fail.
 */
export function slowTransactionThreshold(
  configured?: number | false,
): number | null {
  // Read per call, never cached at module scope. `scripts/build.ts` rewrites
  // `process.env.NODE_ENV` to `Bun.env.NODE_ENV` precisely so mode stays a
  // runtime question in the built framework; caching it here would undo that.
  if (process.env.NODE_ENV !== "development") return null;

  // The one way to switch it off, and it has to be spelled. Everything else
  // falls back, so the warning is never lost to a mistyped value — only to an
  // explicit `false`.
  if (configured === false) return null;

  if (configured === undefined) return SLOW_TRANSACTION_THRESHOLD;
  if (!Number.isFinite(configured) || configured <= 0) {
    return SLOW_TRANSACTION_THRESHOLD;
  }
  return configured;
}

/**
 * Warn, in development only, about a transaction that has been open too long.
 *
 * The risk is structural rather than occasional: an open transaction holds one
 * reserved connection for as long as its callback runs, and nothing about
 * `Model.transaction(async () => { ... })` stops that callback from awaiting a
 * `fetch`, an S3 upload or a slow queue push. Under concurrency that drains the
 * pool, and the symptom — every unrelated query in the process blocking on
 * connection acquisition — names neither the callback nor the I/O in it.
 *
 * A timer rather than measuring elapsed time on the way out, for one reason:
 * the worst case is the transaction that *never* settles (a hung request, a
 * lock wait, a deadlock). After-the-fact measurement is silent for exactly that
 * case; a timer fires while it is still open and still holding the connection.
 *
 * The `Error` is constructed up front and read only if the timer fires — V8
 * formats `.stack` lazily on first access, so an ordinary fast transaction pays
 * for an object allocation and nothing else.
 *
 * The clock starts at the `begin` call, not at the moment a connection is
 * acquired, and stops when `begin` settles rather than when the callback
 * returns — so it spans the pool wait and the commit round-trip as well as the
 * callback. That is deliberate: all three are time this transaction is in
 * flight, and a warning that only covered the callback would stay silent for a
 * transaction stuck waiting on an exhausted pool, which is the exact situation
 * a long transaction elsewhere creates. Hence "not settled" rather than "open
 * for" — the message must not claim a connection was held for the whole span.
 */
function watchForSlowTransaction(configured?: number | false): () => void {
  const threshold = slowTransactionThreshold(configured);
  if (threshold === null) return () => {};

  const site = new Error("transaction opened here");

  const timer = setTimeout(() => {
    const stack = site.stack?.split("\n").slice(1).join("\n") ?? "";
    console.warn(
      `[gemi] A database transaction has not settled after ${threshold}ms. It ` +
        `reserves a pooled connection until it does — check for network or ` +
        `filesystem I/O inside the callback, and move it outside the ` +
        `transaction if you find any.\n${stack}\n` +
        `(development only; set database.slowTransactionThreshold to change ` +
        `the threshold, or false to switch this off)`,
    );
  }, threshold);

  // Otherwise the warning timer is itself a reason the process stays alive,
  // which would turn a diagnostic into a hang in short-lived commands and
  // scripts.
  timer.unref?.();

  return () => clearTimeout(timer);
}

/**
 * Run `fn` inside a transaction, entering the ambient scope for its whole async
 * subtree.
 *
 * The single implementation behind both `Model.transaction` and
 * `DB.transaction`, so the two cannot become transaction systems that ignore
 * each other: a `Model.create` inside a `DB.transaction` joins it, and a raw
 * `DB.sql` inside a `Model.transaction` can join it through
 * `currentTransaction()`.
 *
 * Nesting becomes a savepoint. Not a preference — Bun refuses the alternative
 * outright (`cannot call begin inside a transaction use savepoint() instead`),
 * and a savepoint is the semantics worth having anyway: an inner failure rolls
 * back to it and leaves the outer transaction usable, which a caller that
 * catches can rely on. Verified on SQLite and Postgres.
 *
 * Note Bun hands the savepoint callback the *same* handle object as the outer
 * transaction (`sp === tx`), so the depth counter is the only thing that
 * actually changes on the way in. The callback's argument is still what gets
 * stored, so this keeps working if that ever stops being true. The cast is
 * because Bun types a savepoint handle as plain `SQL` — without `savepoint` on
 * it — while the runtime object does carry the method, which is what makes
 * three levels of nesting work.
 *
 * In development, an outermost transaction that stays open past
 * `options.slowTransactionThreshold` (2s by default, `false` to disable) warns
 * — see `watchForSlowTransaction`. Nothing here *prevents* a long transaction;
 * the warning exists because the cost of one is paid by unrelated queries
 * elsewhere in the process, which makes it hard to trace back.
 *
 * The threshold is passed in rather than read from `app(DatabaseManager)` here.
 * Every caller already holds the manager — it is where `pool` came from — and
 * taking it as an argument keeps this file free of the container, so a bare
 * `SQL` is still enough to call it. Its tests rely on that.
 *
 * `options.connection` is the name `pool` belongs to, and follows the same rule
 * for the same reason: the pool cannot be asked what it is called. Passing it
 * is what lets a nested `withTransaction` tell "the same connection, so take a
 * savepoint" from "a different one, so refuse" — omitting it means the default
 * connection, which is what a two-argument call always meant.
 *
 * The return type is asserted rather than inferred for one reason worth
 * knowing: Bun's `begin` unwraps a callback that resolves to an *array of
 * promises*, awaiting each. So `Model.transaction(async () => [a, b])` where
 * `a` and `b` are promises resolves to their values, not to the promises. That
 * is Bun's behaviour and is left alone; it is only surprising if unmentioned.
 */
export function withTransaction<T>(
  pool: SQL,
  fn: (tx: TransactionSQL) => Promise<T>,
  options?: { slowTransactionThreshold?: number | false; connection?: string },
): Promise<T> {
  const current = ormContext.getStore();

  // THE SINGLE-CONNECTION ASSUMPTION, WHICH IS NOW CHECKED RATHER THAN PINNED.
  //
  // The savepoint branch below ignores `pool` entirely. That was correct while
  // there was one `DatabaseManager` and one `SQL` — the ambient handle and
  // whatever pool the caller passed were necessarily the same database — and
  // the note that stood here said what would happen when a second connection
  // became configurable (#327): a `DB.transaction` on B inside a
  // `Model.transaction` on A would savepoint on **A** and hand the callback A's
  // handle, so statements landed in the wrong database with no error at all.
  //
  // So the name is compared before the branch is taken, and a mismatch raises.
  // Refusing is the whole answer rather than half of one — there is no way to
  // make one transaction span two pools, and the alternatives are covered on
  // `CrossConnectionTransactionError`.
  //
  // A caller that passes no `connection` is treated as naming the default,
  // which is what `withTransaction(pool, fn)` meant before this argument
  // existed.
  const name = options?.connection ?? DEFAULT_CONNECTION;
  assertConnectionUsable(name);

  // `current?.tx` rather than `current`: since iteration 6 a scope can exist
  // with no open transaction — `Model.asSystem` enters one — and a savepoint
  // needs an actual handle, not merely a store.
  if (current?.tx) {
    return current.tx.savepoint((sp) => {
      const nested = sp as TransactionSQL;
      return ormContext.run(
        { ...current, tx: nested, depth: current.depth + 1 },
        () => fn(nested),
      );
    }) as Promise<T>;
  }

  // Only the outermost scope is watched. A savepoint reserves no connection of
  // its own — its lifetime is bounded by the transaction it sits in, which is
  // already being timed — so warning per depth would report one slow block as
  // several warnings and point at the innermost frame rather than the one
  // holding the connection.
  const stopWatching = watchForSlowTransaction(
    options?.slowTransactionThreshold,
  );

  // The `try` covers a *synchronous* throw from `begin` — a closed pool, say.
  // `.finally` alone would not: it is only attached once `begin` has returned a
  // promise, so a synchronous throw escapes with the timer still armed and
  // eventually warns about a transaction that never opened. `unref` keeps that
  // from holding the process, which makes it cosmetic rather than a leak, but
  // it is the same gap the `.finally` below exists to close.
  try {
    // Spread rather than replace: a `Model.transaction` inside a
    // `Model.asSystem` must not silently re-enable policies for its subtree.
    //
    // The connection goes into the scope alongside the handle, and the pair is
    // what makes the check at the top of this function possible: "which
    // connection is this transaction on" has to be answerable from the store,
    // because the handle itself does not say. It is also what makes an
    // unqualified query inside `DB.connection("analytics").transaction(...)`
    // *join* the transaction instead of being refused by it — the query
    // inherits the name rather than defaulting to the hot path.
    return (
      pool
        .begin((tx) =>
          ormContext.run(
            {
              ...current,
              tx,
              depth: 0,
              connection: name === DEFAULT_CONNECTION ? undefined : name,
            },
            () => fn(tx),
          ),
        )
        // `finally` and not a `then`/`catch` pair: the connection is released on
        // rollback exactly as it is on commit, so a throwing callback must clear
        // the timer too or every failed transaction leaves a warning armed
        // against a connection that has already gone back to the pool.
        .finally(stopWatching) as Promise<T>
    );
  } catch (error) {
    stopWatching();
    throw error;
  }
}
