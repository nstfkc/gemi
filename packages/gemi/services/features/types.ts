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
