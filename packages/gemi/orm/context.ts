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
export interface TransactionScope {
  /**
   * Bun's transaction handle. Every ORM statement in scope runs on it, which
   * means they all run on one reserved connection — so nothing here may issue
   * two statements concurrently. `Model.$exec` already runs its nested writes
   * and its relation reads sequentially, for exactly this reason.
   */
  tx: TransactionSQL;
  /** 0 for the outermost transaction, 1+ for each savepoint inside it. */
  depth: number;
}

export const ormContext = new AsyncLocalStorage<TransactionScope>();

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
  return ormContext.getStore()?.depth ?? null;
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

  if (current) {
    return current.tx.savepoint((sp) => {
      const nested = sp as TransactionSQL;
      return ormContext.run({ tx: nested, depth: current.depth + 1 }, () =>
        fn(nested),
      );
    }) as Promise<T>;
  }

  return pool.begin((tx) =>
    ormContext.run({ tx, depth: 0 }, () => fn(tx)),
  ) as Promise<T>;
}
