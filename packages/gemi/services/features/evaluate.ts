import { bucketKey, bucketOf, inRollout } from "./bucket";
import type { Feature } from "./defineFeature";
import type { FeatureContext, FeatureEvaluation } from "./types";

export interface EvaluateOptions {
  /**
   * Whether the database says this feature is switched on. `undefined` means
   * there is no row, which is the state a freshly deployed feature is in.
   */
  active: boolean | undefined;
  /** The store has never loaded successfully. */
  unavailable?: boolean;
  /**
   * Per-request memo of bucket computations, so a feature read in three
   * components hashes once.
   */
  buckets?: Map<string, number>;
  /** Where a throwing `when` is reported. */
  warn?: (message: string) => void;
}

/**
 * Resolves one feature against one context. Pure: no I/O, no container, and no
 * clock of its own — `ctx.now` is the clock.
 *
 * ## Order
 *
 * 1. The store never loaded → **off**.
 * 2. No row, or `active === false` → **off**. `when` and `rollout` are not
 *    consulted.
 * 3. `when(ctx)` returned a boolean → that.
 * 4. A crawler → **off**.
 * 5. No `rollout` → **on**.
 * 6. Inside the rollout bucket → on, otherwise off.
 *
 * ## Why an unreachable database means off
 *
 * The store keeps its last good snapshot across a failed refresh, so this only
 * applies to a cold process that has never loaded — a deploy landing while the
 * database is down. Answering "on" there would turn features on at the moment
 * the operator has the least ability to turn them off again, which is the wrong
 * direction to fail in. Answering "off" degrades to the behaviour of the release
 * before the feature existed.
 *
 * ## Why `active` short-circuits
 *
 * It is the kill switch, and a kill switch that targeting could defeat is not
 * one. Turning a feature off during an incident is a single column an on-call
 * engineer flips, and it has to be true that nothing in application code can
 * override it — including a `when` somebody wrote last month and forgot.
 *
 * ## Why `when` outranks `rollout`
 *
 * A rollout is a statement about strangers; `when` is a statement about someone
 * you can name. Staff overrides and plan-level exclusions have to beat the dice,
 * or they are not overrides. Abstaining — returning nothing — is how a `when`
 * says it has no opinion about this subject and the dice should decide.
 */
export function evaluateFeature(
  key: string,
  feature: Feature,
  ctx: FeatureContext,
  options: EvaluateOptions,
): FeatureEvaluation {
  if (options.unavailable) {
    return { value: false, reason: "unavailable" };
  }
  if (options.active !== true) {
    return { value: false, reason: "inactive" };
  }

  if (feature.when) {
    let decision: boolean | undefined | void;
    try {
      decision = feature.when(ctx);
    } catch (error) {
      // `when: (ctx) => ctx.user.plan === "pro"` throws on every anonymous page
      // load, and letting that escape would white-screen the marketing site over
      // a missing `?.`. Off rather than abstain: a targeting function that could
      // not run has not decided anybody is eligible, and falling through to the
      // rollout would ship the feature to a slice of users the author never
      // approved.
      options.warn?.(
        `The \`when\` for feature "${key}" threw; treating it as off. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { value: false, reason: "error" };
    }
    if (typeof decision === "boolean") {
      return { value: decision, reason: "attributed" };
    }
  }

  if (feature.rollout === undefined) {
    return { value: true, reason: "on" };
  }

  // A crawler has no stable subject to bucket, so it would sample the rollout
  // afresh on every visit and index whichever side it happened to land on.
  // Pinning it to the pre-rollout experience keeps one URL serving one document.
  if (ctx.isBot) {
    return { value: false, reason: "bot" };
  }

  const bucket = bucketFor(key, feature, ctx, options.buckets);
  return inRollout(bucket, feature.rollout)
    ? { value: true, reason: "rollout" }
    : { value: false, reason: "excluded" };
}

/**
 * The subject a rollout buckets on: the signed-in user, else the `session_id`
 * cookie.
 *
 * Preferring the user id is what makes an assignment follow someone across
 * devices, and it is why signing up can move a visitor from one side of a
 * rollout to the other — there is no id that is both stable per person and
 * known before they have an account. The trade is worth it in that direction;
 * the reverse would give every logged-in user a different answer per browser.
 *
 * The empty string is the honest floor. Outside a request — a job, a cron tick —
 * there is no subject at all, and every context then shares one bucket. A random
 * value would be worse, not better: it would give the same subject a different
 * answer on every call, which is the one thing bucketing exists to prevent.
 */
export function subjectFor(ctx: FeatureContext): string {
  const userId = ctx.user?.publicId ?? ctx.user?.id;
  if (userId !== undefined && userId !== null) return String(userId);
  return ctx.anonymousId ?? "";
}

function bucketFor(
  key: string,
  feature: Feature,
  ctx: FeatureContext,
  memo: Map<string, number> | undefined,
): number {
  const hashKey = bucketKey(feature.salt ?? key, subjectFor(ctx));
  if (!memo) return bucketOf(hashKey);

  const cached = memo.get(hashKey);
  if (cached !== undefined) return cached;

  const bucket = bucketOf(hashKey);
  memo.set(hashKey, bucket);
  return bucket;
}
