import type { FlagValue } from "../../http/FeatureRouter";

export type { FlagValue };

/**
 * The comparisons a rule condition can make.
 *
 * There is deliberately **no regex operator**. A pattern that arrives from a
 * `Json` column an operator edits, and is then run against user-controlled
 * attributes on the SSR hot path, is a denial-of-service surface with no upside
 * that `in`/`startsWith`/`contains` do not already cover.
 */
export type ConditionOperator =
  | "eq"
  | "neq"
  | "in"
  | "nin"
  | "contains"
  | "ncontains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "before"
  | "after"
  | "exists"
  | "nexists";

export interface Condition {
  /** Dot path into the evaluation context: `user.globalRole`, `attributes.plan`. */
  attribute: string;
  operator: ConditionOperator;
  /** Absent for `exists` / `nexists`. */
  value?: unknown;
}

export interface VariantWeight {
  value: FlagValue;
  /** Relative. Normalised against the sum, so 1/1 and 50/50 mean the same. */
  weight: number;
}

export interface Rule {
  /**
   * Stable identity, and load-bearing: it salts the rollout bucket, so a rule
   * that changes id re-buckets everyone it was serving.
   */
  id: string;
  description?: string;
  /** AND-ed. Absent or empty matches everyone. */
  conditions?: Condition[];
  /** Segment keys from config, AND-ed with `conditions`. */
  segments?: string[];
  /** 0–100. Absent means 100. */
  rollout?: number;
  /** Exactly one of `value` / `variants`. */
  value?: FlagValue;
  variants?: VariantWeight[];
  /** Overrides the flag's bucketing attribute for this rule only. */
  bucketBy?: string;
}

/**
 * A flag as the evaluator sees it: the code declaration and the database row
 * merged, with every field resolved to a definite value.
 */
export interface FeatureFlagDefinition {
  key: string;
  enabled: boolean;
  /** Served when `enabled` is false. Defaults to the declared default. */
  offValue: FlagValue;
  /** Served when enabled and nothing matched. Defaults to the declared default. */
  defaultValue: FlagValue;
  rules: Rule[];
  seed: string;
  bucketBy: string | null;
  /** From the code declaration, never the row: the row cannot make a flag public. */
  serverOnly: boolean;
}

export interface EvaluationContext {
  /** The session user, or null. Never throws for an anonymous visitor. */
  user: Record<string, any> | null;
  /** Application-supplied extras, reachable as `attributes.*`. */
  attributes: Record<string, unknown>;
  request: {
    path: string | null;
    routePath: string | null;
    locale: string | null;
  };
  /** The stable anonymous subject — the `session_id` cookie. */
  anonymousId: string | null;
  now: Date;
}

export type EvaluationReason =
  | "disabled"
  | "unknown"
  | "rule"
  | "default"
  | "unavailable"
  | "error";

export interface FlagEvaluation {
  value: FlagValue;
  /**
   * Server-only diagnostics. Never serialized into the SSR payload — knowing
   * *which* rule matched tells a user which segment they are in.
   */
  reason: EvaluationReason;
  ruleId: string | null;
}
