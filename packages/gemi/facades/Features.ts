import type { FeatureKey, FeatureValueOf } from "../client/rpc";
import type { FlagValue } from "../http/FeatureRouter";
import { FeatureManager, type FeatureScope } from "../services/features/FeatureManager";
import type { FeatureSubject } from "../services/features/context";
import type { FlagEvaluation } from "../services/features/types";
import { Facade } from "./Facade";

/**
 * Feature flags on the server.
 *
 * Keys are typed against the application's `app/features` declarations, so a
 * typo is a compile error rather than a flag that is silently always off.
 *
 * ```ts
 * if (await Features.enabled("new-checkout")) { ... }
 *
 * switch (await Features.value("pricing-page")) {
 *   case "a": ...
 * }
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
 * would have to answer that case with the default, which is a flag silently
 * reading "off" during exactly the window a deploy is rolling.
 *
 * ## The ambient user
 *
 * Read from the request store, not `Auth.user()` — flags must be evaluable on an
 * anonymous page without throwing. On a route with no `auth` middleware, where
 * nothing has resolved a session, user-targeted rules will not match.
 */
export class Features extends Facade {
  static getFacadeAccessor() {
    return FeatureManager;
  }

  /** Whether the flag is on. `false`, `null` and `undefined` are all off. */
  static enabled(key: FeatureKey): Promise<boolean> {
    return this.getFacadeRoot().enabled(key as string);
  }

  /** The resolved value, typed by the declaration. */
  static value<K extends FeatureKey>(key: K): Promise<FeatureValueOf<K>> {
    return this.getFacadeRoot().value(key as string) as Promise<FeatureValueOf<K>>;
  }

  /**
   * Every client-visible flag for this request, as `key -> value`. This is what
   * the SSR payload carries.
   */
  static all(): Promise<Record<string, FlagValue>> {
    return this.getFacadeRoot().forClient();
  }

  /**
   * Value plus the rule that produced it.
   *
   * **Server-side only.** `reason` and `ruleId` identify which rule matched,
   * which is to say which segment the viewer is in — never serialize this into
   * a response.
   */
  static explain(key: FeatureKey): Promise<FlagEvaluation> {
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
