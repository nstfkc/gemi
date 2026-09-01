import type { FeatureKey } from "../client/rpc";
import type { FeatureSubject } from "../services/features/context";
import { FeatureManager, type FeatureScope } from "../services/features/FeatureManager";
import type { FeatureEvaluation, FeatureListing } from "../services/features/types";
import { Facade } from "./Facade";

/**
 * Features on the server.
 *
 * Keys are typed against the application's `app/features` declarations, so a
 * typo is a compile error rather than a feature that is silently always off.
 *
 * ```ts
 * if (await Features.enabled("new-checkout")) { ... }
 *
 * // In a job or cron tick, where there is no request to read a user from:
 * if (await Features.for({ user }).enabled("digest-v2")) { ... }
 * ```
 *
 * ## Everything is async, and there is no sync variant
 *
 * After the boot-time warm-up every call settles in a microtask with no I/O —
 * the snapshot is in memory and refreshes behind the request. The promise is
 * kept anyway because the *first* call in a cold process does hit the database,
 * and because a source that is not the local table will too. A sync variant
 * would have to answer that case with "off", which is a feature silently
 * disappearing during exactly the window a deploy is rolling.
 *
 * ## The ambient user
 *
 * Read from the request store, not `Auth.user()` — features must be evaluable on
 * an anonymous page without throwing. On a route with no `auth` middleware,
 * where nothing has resolved a session, a `when` that reads `ctx.user` sees
 * `null`.
 */
export class Features extends Facade {
  static getFacadeAccessor() {
    return FeatureManager;
  }

  /** Whether the feature is on for this request. */
  static enabled(key: FeatureKey): Promise<boolean> {
    return this.getFacadeRoot().enabled(key as string);
  }

  /**
   * Every client-visible feature for this request. This is what the SSR payload
   * carries.
   */
  static all(): Promise<Record<string, boolean>> {
    return this.getFacadeRoot().forClient();
  }

  /**
   * Value plus why.
   *
   * **Server-side only.** `reason` distinguishes "targeted by name" from "landed
   * in the rollout", which is a fact about the viewer — never serialize it into
   * a response.
   */
  static explain(key: FeatureKey): Promise<FeatureEvaluation> {
    return this.getFacadeRoot().explain(key as string);
  }

  /** Evaluation against an explicit subject rather than the ambient request. */
  static for(subject: FeatureSubject): FeatureScope {
    return this.getFacadeRoot().for(subject);
  }

  /**
   * Every feature declared in the code, with its switch — the list an admin
   * screen renders.
   *
   * The declarations are what exists. A feature is here because `app/features`
   * declares it, never because a row was inserted; `active` is `undefined` for a
   * feature that has been deployed but never switched on, which is deliberately
   * distinct from a row that says `false`.
   *
   * Check `unavailable` before rendering `active`. It means no snapshot has ever
   * loaded, so the switches are unknown rather than absent.
   *
   * **Server-side only, and the route must be gated.** The listing includes
   * `serverOnly` features — whose keys are the thing `serverOnly` exists to keep
   * out of the payload — and every descriptor carries `rollout` and `targeted`,
   * which describe who is in an experiment.
   *
   * ```ts
   * // app/http/routes/api.ts
   * "/admin/features": this.get([AdminFeatureController, "index"]).middleware(["admin"]),
   *
   * // app/http/controllers/AdminFeatureController.ts
   * public async index() {
   *   return await Features.list();
   * }
   * ```
   */
  static list(): Promise<FeatureListing> {
    return this.getFacadeRoot().list();
  }

  /** Reloads this process's snapshot now, rather than waiting for the TTL. */
  static refresh(): Promise<void> {
    return this.getFacadeRoot().refresh();
  }

  /**
   * Call this after writing to the `FeatureFlag` table.
   *
   * ```ts
   * public async update(
   *   request: HttpRequest<{ active: boolean }, { key: string }>,
   * ) {
   *   const input = await request.input();
   *
   *   await FeatureFlag.update({
   *     where: { key: request.params.key },
   *     data: { active: input.get("active") },
   *   });
   *
   *   await Features.invalidate();
   *   return await Features.list();
   * }
   * ```
   *
   * Unlike `refresh()` this never settles on a load that started before it was
   * called, so the `list()` above reflects the write that precedes it. It also
   * clears the request's evaluation memo, so a feature read earlier in the same
   * request is re-evaluated rather than answered from before the write.
   *
   * **Throws `FeatureReloadError` when the reload fails.** The write landed and
   * the cache did not follow, so the switches in memory may still predate it;
   * returning normally would present them as the result of the update. This is
   * the one call in the subsystem that fails loudly — everywhere else an outage
   * means "keep serving what we have", which is right for evaluation and wrong
   * for an operator watching their own change.
   *
   * **Process-local.** The other instances are still serving their own
   * snapshots and converge within `ttl` — there is no cross-instance
   * invalidation. What this fixes is the window that reads as a bug: the admin
   * who flips a switch and is told for the next thirty seconds that nothing
   * happened.
   */
  static invalidate(): Promise<void> {
    return this.getFacadeRoot().invalidate();
  }
}
