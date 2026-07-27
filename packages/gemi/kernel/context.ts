import { AsyncLocalStorage } from "async_hooks";

/**
 * The kernel's AsyncLocalStorage. It holds the Application, and nothing else —
 * `Kernel.run()` enters it once per request, websocket message or cron tick,
 * and `foundation/app.ts` reads it to resolve services.
 *
 * There was exactly one AsyncLocalStorage in the framework until iteration 5 of
 * the ORM. There are now two, and this note is here so that claim does not
 * quietly become false where someone would otherwise still be relying on it.
 *
 * The second is `packages/gemi/orm/context.ts`, holding an open transaction
 * handle and its nesting depth. It is deliberately separate rather than merged
 * into this one:
 *
 * - A transaction scope nests *inside* an Application scope without replacing
 *   it. Re-entering this store with a `{ app, tx }` wrapper would mean every
 *   reader of it — `app()` above all — has to handle two shapes forever, and a
 *   miss there is not a transaction bug, it is a service resolving off the
 *   wrong Application.
 * - The alternative of hanging the handle off the Application is worse than a
 *   style question: one Application serves every concurrent request, so two
 *   overlapping transactions would overwrite each other's handle and statements
 *   would land in the wrong one. That is silent data corruption.
 *
 * The cost is honest: two stores on the hot path of every query instead of one.
 * The ORM's is shallow — one small object, entered only inside
 * `Model.transaction` or `DB.transaction`, never per request — so a query
 * outside a transaction pays one `getStore()` returning undefined.
 *
 * If a third is ever proposed, this is the note to read first: the bar is that
 * the state is genuinely per-async-scope *and* cannot live in an existing
 * store without making that store's readers ambiguous.
 */
export const kernelContext = new AsyncLocalStorage();
