import { AsyncLocalStorage } from "async_hooks";

/**
 * The kernel's AsyncLocalStorage. It holds the Application, and nothing else —
 * `Kernel.run()` enters it once per request, websocket message or cron tick,
 * and `foundation/app.ts` reads it to resolve services.
 *
 * "The framework's only AsyncLocalStorage" is a claim that used to sit here. It
 * was already not true — the *kernel's* is the only one, but `http/`, `pubsub/`
 * and now the ORM each keep their own. Four in the shipped framework (a fifth
 * sits in `rfc/workflow.ts`, an unreferenced design sketch that is outside
 * `package.json`'s exports and that nothing imports):
 *
 *   kernel     kernel/context.ts                     the Application
 *   request    http/requestContext.ts                req, user, cookies, locale
 *   broadcast  services/pubsub/BroadcastManager.ts   headers, cookies
 *   orm        orm/context.ts                        an open transaction
 *
 * The pattern is one store per scope with one owner, entered by that owner and
 * read through its own accessor — `app()`, `RequestContext.getStore()`,
 * `currentTransaction()`. What matters is that this one holds the Application
 * and nothing else, because `foundation/app.ts` reads it unconditionally.
 *
 * The ORM's, added in iteration 5, holds an open transaction handle and its
 * nesting depth. It is deliberately separate rather than merged into this one:
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
 * The cost is honest: one more store on the hot path of every query. The ORM's
 * is shallow — one small object, entered only inside `Model.transaction` or
 * `DB.transaction`, never per request — so a query outside a transaction pays
 * one `getStore()` returning undefined.
 *
 * If another is ever proposed, this is the note to read first: the bar is that
 * the state is genuinely per-async-scope *and* cannot live in an existing store
 * without making that store's readers ambiguous.
 */
export const kernelContext = new AsyncLocalStorage();
