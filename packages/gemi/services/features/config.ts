import type { FeatureRouter, FlagValue } from "../../http/FeatureRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { DatabaseFeatureFlagSource } from "./sources/DatabaseFeatureFlagSource";
import type { FeatureFlagSource } from "./sources/FeatureFlagSource";
import type { Condition, EvaluationContext, FlagEvaluation } from "./types";

// Config key: `features`. Derived from `FeaturesServiceProvider`.
export interface FeaturesConfig {
  /**
   * The application's flag declarations — the default export of
   * `app/features/index.ts`.
   *
   * Named here as well as in the framework's `gemi.d.ts` because the two layers
   * cannot share one reference: the type augmentation resolves `@/app/features`
   * through the app's tsconfig paths, which exists only at compile time. This is
   * the runtime half. They should point at the same class.
   */
  router?: (new () => FeatureRouter) | FeatureRouter;

  /**
   * Master switch. `false` skips loading and evaluation entirely: every flag
   * resolves to its declared default and the SSR payload carries `{}`.
   */
  enabled?: boolean;

  /** Where rows come from. The database by default. */
  source?: FeatureFlagSource;

  /** ORM registry name of the flag model, when using the database source. */
  model?: string;

  /**
   * Snapshot lifetime in **seconds**.
   *
   * This is the propagation delay: an edit is live on every instance within this
   * window, including a kill switch. Lower it if that matters more than the
   * query volume — there is no cross-instance invalidation.
   */
  ttl?: number;

  /** Default bucketing attribute path when neither rule nor flag names one. */
  bucketBy?: string;

  /**
   * Named condition sets a rule can reference by key.
   *
   * In code rather than the database because a segment reused by ten flags
   * should be edited once, and because "who counts as an enterprise account" is
   * business logic that belongs in review.
   */
  segments?: Record<string, Condition[]>;

  /**
   * Extra attributes for every evaluation — country, cohort, build, plan.
   * Reachable in a rule as `attributes.*` or bare.
   */
  context?: (
    req: HttpRequest | null,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;

  /**
   * Called once per key per request after evaluation — the hook an analytics
   * or experiment pipeline reads exposures from. Errors are caught and logged.
   */
  onEvaluate?: (key: string, evaluation: FlagEvaluation, ctx: EvaluationContext) => void;

  /** Warn once per boot above this many client-visible flags. */
  maxClientFlags?: number;
}

export function defineFeaturesConfig(config: FeaturesConfig): FeaturesConfig {
  return config;
}

export function featuresConfigDefaults(): Required<
  Omit<FeaturesConfig, "router" | "context" | "onEvaluate">
> & {
  router: FeaturesConfig["router"];
  context: FeaturesConfig["context"];
  onEvaluate: FeaturesConfig["onEvaluate"];
} {
  return {
    router: undefined,
    enabled: true,
    source: new DatabaseFeatureFlagSource(),
    model: "FeatureFlag",
    ttl: 30,
    bucketBy: "user.publicId",
    segments: {},
    context: undefined,
    onEvaluate: undefined,
    maxClientFlags: 200,
  };
}

export type ResolvedFeaturesConfig = ReturnType<typeof featuresConfigDefaults>;

export type { FlagValue };
