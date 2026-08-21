import type { HttpRequest } from "../../http/HttpRequest";
import type { FeatureRegistry } from "./defineFeature";
import { DatabaseFeatureFlagSource } from "./sources/DatabaseFeatureFlagSource";
import type { FeatureFlagSource } from "./sources/FeatureFlagSource";
import type { FeatureContext, FeatureEvaluation } from "./types";

// Config key: `features`. Derived from `FeaturesServiceProvider`.
export interface FeaturesConfig {
  /**
   * The application's declarations — the default export of
   * `app/features/index.ts`.
   *
   * Named here as well as in the framework's `gemi.d.ts` because the two layers
   * cannot share one reference: the type augmentation resolves `@/app/features`
   * through the app's tsconfig paths, which exists only at compile time. This is
   * the runtime half. They should point at the same object.
   */
  features?: FeatureRegistry;

  /**
   * Master switch. `false` skips loading and evaluation entirely: every feature
   * reads off and the SSR payload carries `{}`.
   */
  enabled?: boolean;

  /** Where the on/off switches come from. The database by default. */
  source?: FeatureFlagSource;

  /** ORM registry name of the model, when using the database source. */
  model?: string;

  /**
   * Snapshot lifetime in **seconds**.
   *
   * This is the propagation delay: switching a feature on or off is live on
   * every instance within this window. Lower it if that matters more than the
   * query volume — there is no cross-instance invalidation.
   */
  ttl?: number;

  /**
   * Extra attributes for every evaluation — country, cohort, build, plan.
   * Reachable in a `when` as `ctx.attributes`.
   *
   * Runs on every request inside the render path, so keep it cheap and free of
   * I/O. If it throws, evaluation degrades to no attributes rather than failing
   * the page.
   */
  context?: (req: HttpRequest | null) => Record<string, unknown> | Promise<Record<string, unknown>>;

  /**
   * Called once per key per request after evaluation — the hook an analytics or
   * experiment pipeline reads exposures from. Errors are caught and logged.
   */
  onEvaluate?: (key: string, evaluation: FeatureEvaluation, ctx: FeatureContext) => void;

  /** Warn once per boot above this many client-visible features. */
  maxClientFlags?: number;
}

export function defineFeaturesConfig(config: FeaturesConfig): FeaturesConfig {
  return config;
}

export function featuresConfigDefaults(): Required<
  Omit<FeaturesConfig, "features" | "context" | "onEvaluate">
> & {
  features: FeaturesConfig["features"];
  context: FeaturesConfig["context"];
  onEvaluate: FeaturesConfig["onEvaluate"];
} {
  return {
    features: undefined,
    enabled: true,
    source: new DatabaseFeatureFlagSource(),
    model: "FeatureFlag",
    ttl: 30,
    context: undefined,
    onEvaluate: undefined,
    maxClientFlags: 200,
  };
}

export type ResolvedFeaturesConfig = ReturnType<typeof featuresConfigDefaults>;
