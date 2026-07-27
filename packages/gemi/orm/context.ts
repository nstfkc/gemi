import type { SQL, TransactionSQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";

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
 */
export function runAsUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  const current = ormContext.getStore();
  return ormContext.run(
    { ...current, depth: current?.depth ?? 0, actor: { user } },
    fn,
  );
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
 * The return type is asserted rather than inferred for one reason worth
 * knowing: Bun's `begin` unwraps a callback that resolves to an *array of
 * promises*, awaiting each. So `Model.transaction(async () => [a, b])` where
 * `a` and `b` are promises resolves to their values, not to the promises. That
 * is Bun's behaviour and is left alone; it is only surprising if unmentioned.
 */
export function withTransaction<T>(
  pool: SQL,
  fn: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
  const current = ormContext.getStore();

  // SINGLE-CONNECTION ASSUMPTION, pinned here so it is found rather than
  // discovered. The savepoint branch ignores `pool` entirely, which is correct
  // today: there is one `DatabaseManager` and one `SQL`, so the ambient handle
  // and whatever pool the caller passed are necessarily the same database.
  //
  // It stops being correct the moment a second connection is configurable. A
  // `DB.transaction` against connection B, called inside a `Model.transaction`
  // on A, would open a savepoint on **A** and hand the callback A's handle —
  // statements landing in the wrong database, with no error. That is the same
  // failure shape as the "handle on the Application" alternative this file
  // argues against. Multi-connection support must compare the two and either
  // join or refuse, not fall through to here.
  //
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

  // Spread rather than replace: a `Model.transaction` inside a `Model.asSystem`
  // must not silently re-enable policies for its whole subtree.
  return pool.begin((tx) =>
    ormContext.run({ ...current, tx, depth: 0 }, () => fn(tx)),
  ) as Promise<T>;
}
