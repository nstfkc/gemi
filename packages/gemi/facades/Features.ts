import type { FeatureKey } from "../client/rpc";
import type { FeatureSubject } from "../services/features/context";
import { FeatureManager, type FeatureScope } from "../services/features/FeatureManager";
import type { FeatureEvaluation } from "../services/features/types";
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

  /** Reloads this process's snapshot now, rather than waiting for the TTL. */
  static refresh(): Promise<void> {
    return this.getFacadeRoot().refresh();
  }
}
