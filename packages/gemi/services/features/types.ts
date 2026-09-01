/**
 * What a feature is evaluated against.
 *
 * Assembled once per request and memoised on the request store, so declaring a
 * hundred features costs one context, not a hundred.
 */
export interface FeatureContext {
  /** The session user, or `null`. Never throws for an anonymous visitor. */
  user: Record<string, any> | null;
  /** Application-supplied extras from `app/config/features.ts`. */
  attributes: Record<string, unknown>;
  request: {
    path: string | null;
    routePath: string | null;
    locale: string | null;
  };
  /**
   * The stable anonymous subject — the `session_id` cookie.
   *
   * This is what makes a percentage rollout hold still for a logged-out
   * visitor. It is minted at the top of every view request rather than at the
   * end of one, so the id used to bucket is the id the browser is about to be
   * given.
   */
  anonymousId: string | null;
  /**
   * A crawler sent this request.
   *
   * Bots discard cookies, so every crawl of the same URL would otherwise mint a
   * fresh `session_id`, land in a fresh bucket, and index a different variant
   * than the last crawl. They are pinned off instead.
   */
  isBot: boolean;
  now: Date;
}

/**
 * Why a feature resolved the way it did. Server-side diagnostics — never
 * serialized, because "you are in the rollout" is a fact about the viewer.
 */
export type EvaluationReason =
  /** No such key in `app/features`. */
  | "undeclared"
  /** No row, or the row says off. The kill switch. */
  | "inactive"
  /** `when` returned a definite answer. */
  | "attributed"
  /** Inside the rollout bucket. */
  | "rollout"
  /** Outside the rollout bucket. */
  | "excluded"
  /** A crawler; rollouts are pinned off. */
  | "bot"
  /** Switched on with no `when` opinion and no `rollout`. */
  | "on"
  /** `when` threw. Treated as off. */
  | "error"
  /** The store has never loaded, so nothing is known. Fails closed. */
  | "unavailable";

export interface FeatureEvaluation {
  value: boolean;
  reason: EvaluationReason;
}

/**
 * One declared feature, flattened for a human-facing list — an admin screen, a
 * console command.
 *
 * The declarations are what exists: a feature is on this list because the code
 * declares it, never because somebody inserted a row. The database contributes
 * exactly one field, `active`, which is the only thing it owns.
 *
 * `when` is not here and cannot be. It is a function over the viewer, so the
 * honest answer to "who does this target" is only ever "run it" — `targeted`
 * reports that targeting exists, and `Features.for(subject).explain(key)`
 * answers it for one subject at a time.
 */
export interface FeatureDescriptor {
  key: string;
  /** `describe` from the declaration. */
  describe?: string;
  /** `0`–`100`, or `undefined` for "everyone". */
  rollout?: number;
  /** Whether the declaration carries a `when`. The function itself stays put. */
  targeted: boolean;
  /** Evaluated on the server, never in the SSR payload. */
  serverOnly: boolean;
  /** The declared bucketing salt, or `undefined` when it is the key. */
  salt?: string;
  /**
   * The switch.
   *
   * `undefined` means **no row** — a feature that has been deployed but never
   * switched on, which is not the same as a row that says `false`, and is a
   * difference an admin list has to show: one is untouched, the other is
   * somebody's decision. Also `undefined` throughout when `enabled: false` turns
   * the subsystem off, because then nothing reads the table at all.
   */
  active: boolean | undefined;
}
