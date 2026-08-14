import { bucketKey, bucketOf, inRollout, pickVariant } from "./bucket";
import { attributeAt, matchAll } from "./conditions";
import type {
  Condition,
  EvaluationContext,
  FeatureFlagDefinition,
  FlagEvaluation,
  FlagValue,
  Rule,
} from "./types";

export const DEFAULT_BUCKET_BY = "user.publicId";

export interface EvaluateOptions {
  /**
   * The default from `app/features` — the answer whenever the database has
   * nothing to say. Passed in rather than read from the definition because it
   * belongs to the code declaration, and the code declaration is what exists
   * when the row does not.
   */
  declaredDefault: FlagValue;
  /** Named condition sets from `app/config/features.ts`. */
  segments?: Record<string, Condition[]>;
  /** Default bucketing path when neither the rule nor the flag names one. */
  bucketBy?: string;
  /** The store has never loaded successfully. */
  unavailable?: boolean;
  /**
   * Per-request memo of bucket computations. A flag with both a rollout gate
   * and a variant split hashes twice; without this it would hash once per
   * condition evaluated against it.
   */
  buckets?: Map<string, number>;
}

/**
 * Resolves one flag against one context. Pure: no I/O, no container, no clock
 * of its own (`ctx.now` is the clock).
 *
 * ## Order
 *
 * 1. The store never loaded → the declared default.
 * 2. No row for this key → the declared default.
 * 3. `enabled === false` → `offValue`. **Rules are not consulted.**
 * 4. First rule that matches — segments, conditions, and its rollout bucket —
 *    serves its value.
 * 5. Nothing matched → `defaultValue`.
 *
 * ## Why `enabled` short-circuits
 *
 * It is the kill switch, and a kill switch that any rule could defeat is not
 * one. Turning a flag off during an incident is a single column an on-call
 * engineer flips, and it has to be true that nothing else in the row can
 * override it — including a rule somebody added last month and forgot.
 *
 * ## Why the rollout is part of *matching*, not of serving
 *
 * A rule whose conditions hold but whose bucket does not pass falls through to
 * the next rule. That composes: "10% of pro accounts get the beta, everyone
 * else gets the variant rule below" is two rules, read top to bottom, and each
 * one is independently comprehensible. The alternative — a matched rule serving
 * `offValue` to the other 90% — makes the first rule silently terminal and the
 * rules beneath it dead code that still looks live.
 *
 * Monotonicity survives either way: `inRollout` is a `<` test, so raising a
 * rollout only ever adds subjects.
 */
export function evaluateFlag(
  flag: FeatureFlagDefinition | undefined,
  ctx: EvaluationContext,
  options: EvaluateOptions,
): FlagEvaluation {
  const { declaredDefault } = options;

  if (options.unavailable) {
    return { value: declaredDefault, reason: "unavailable", ruleId: null };
  }
  if (!flag) {
    return { value: declaredDefault, reason: "unknown", ruleId: null };
  }
  if (!flag.enabled) {
    return { value: flag.offValue, reason: "disabled", ruleId: null };
  }

  for (const rule of flag.rules) {
    const outcome = applyRule(rule, flag, ctx, options);
    if (outcome) return outcome;
  }

  return { value: flag.defaultValue, reason: "default", ruleId: null };
}

/** `null` when the rule does not apply, so the caller moves to the next one. */
function applyRule(
  rule: Rule,
  flag: FeatureFlagDefinition,
  ctx: EvaluationContext,
  options: EvaluateOptions,
): FlagEvaluation | null {
  for (const key of rule.segments ?? []) {
    const segment = options.segments?.[key];
    // A rule naming a segment that no longer exists must not silently become a
    // catch-all — that would widen its audience to everyone at the moment
    // somebody deletes a definition.
    if (!segment || !matchAll(segment, ctx)) return null;
  }

  if (!matchAll(rule.conditions, ctx)) return null;

  const subject = subjectFor(rule, flag, ctx, options);

  if (rule.rollout !== undefined && rule.rollout < 100) {
    const bucket = bucketFor("rollout", flag, rule, subject, options);
    if (!inRollout(bucket, rule.rollout)) return null;
  }

  if (rule.variants && rule.variants.length > 0) {
    const bucket = bucketFor("variant", flag, rule, subject, options);
    const value = pickVariant(rule.variants, bucket);
    if (value === null) {
      // The weights do not describe a distribution. Serving an arbitrary
      // variant would be a coin flip nobody configured, so fall back to the
      // flag's own default and say why.
      return { value: flag.defaultValue, reason: "error", ruleId: rule.id };
    }
    return { value, reason: "rule", ruleId: rule.id };
  }

  return { value: rule.value ?? flag.defaultValue, reason: "rule", ruleId: rule.id };
}

function subjectFor(
  rule: Rule,
  flag: FeatureFlagDefinition,
  ctx: EvaluationContext,
  options: EvaluateOptions,
): string {
  const path = rule.bucketBy ?? flag.bucketBy ?? options.bucketBy ?? DEFAULT_BUCKET_BY;
  const raw = attributeAt(ctx, path);
  if (raw !== undefined && raw !== null) return String(raw);

  // Signed-out, or bucketing on an attribute this context does not carry. The
  // `session_id` cookie is the fallback subject, which is why it is minted at
  // the top of every view request rather than at the end of one.
  //
  // The empty string is the honest floor: outside a request — a job, a cron
  // tick — there is no subject at all, and every context then shares a bucket.
  // A random value here would be worse, not better: it would give the same user
  // a different answer on every call.
  return ctx.anonymousId ?? "";
}

function bucketFor(
  namespace: "rollout" | "variant",
  flag: FeatureFlagDefinition,
  rule: Rule,
  subject: string,
  options: EvaluateOptions,
): number {
  const key = bucketKey(namespace, flag.key, flag.seed, rule.id, subject);
  const memo = options.buckets;
  if (!memo) return bucketOf(key);

  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const bucket = bucketOf(key);
  memo.set(key, bucket);
  return bucket;
}
