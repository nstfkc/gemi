import {
  FeatureRouter,
  flattenFeatures,
  type FeatureFlag,
  type FlagValue,
} from "../../http/FeatureRouter";
import { RequestContext } from "../../http/requestContext";
import type { ResolvedFeaturesConfig } from "./config";
import { contextFromRequest, contextFromSubject, type FeatureSubject } from "./context";
import { evaluateFlag } from "./evaluate";
import { FeatureFlagStore } from "./FeatureFlagStore";
import type { EvaluationContext, FeatureFlagDefinition, FlagEvaluation } from "./types";

/**
 * Evaluation bound to one explicit context — what `Features.for(...)` returns.
 *
 * Exists because a job, a cron tick or an admin preview needs to ask "what would
 * *this* user see", and the ambient-request path cannot answer that.
 */
export class FeatureScope {
  constructor(
    private readonly manager: FeatureManager,
    private readonly ctx: EvaluationContext,
  ) {}

  async enabled(key: string): Promise<boolean> {
    return isOn((await this.explain(key)).value);
  }

  async value<T extends FlagValue = FlagValue>(key: string): Promise<T> {
    return (await this.explain(key)).value as T;
  }

  async explain(key: string): Promise<FlagEvaluation> {
    return await this.manager.evaluateIn(key, this.ctx, new Map());
  }

  async all(): Promise<Record<string, FlagValue>> {
    return await this.manager.evaluateAllIn(this.ctx, new Map(), { clientOnly: false });
  }
}

/** `false`, `null` and `undefined` are off; everything else is on. */
function isOn(value: FlagValue | undefined): boolean {
  return value !== false && value !== null && value !== undefined;
}

export class FeatureManager {
  static token = "features";

  readonly store: FeatureFlagStore;
  private readonly declared: Map<string, FeatureFlag<FlagValue>>;
  private warnedAboutSize = false;

  constructor(
    readonly config: ResolvedFeaturesConfig,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.declared = collectDeclarations(config.router, this.log);
    this.store = new FeatureFlagStore(
      config.source,
      this.declared,
      Math.max(0, config.ttl) * 1000,
      this.log,
    );
  }

  /** The declared flags, for a CLI or admin surface. Server-side only. */
  declarations(): Map<string, FeatureFlag<FlagValue>> {
    return this.declared;
  }

  /** Reloads the snapshot in this process now. */
  async refresh(): Promise<void> {
    if (!this.config.enabled) return;
    // Nothing is declared, so there is nothing a row could resolve to. Skipping
    // the query keeps an app that never adopted flags from touching the
    // database — and from logging that it has no `FeatureFlag` model, which
    // would be a boot-time complaint about an unused feature.
    if (this.declared.size === 0) return;
    await this.store.refresh();
  }

  async enabled(key: string): Promise<boolean> {
    return isOn((await this.explain(key)).value);
  }

  async value<T extends FlagValue = FlagValue>(key: string): Promise<T> {
    return (await this.explain(key)).value as T;
  }

  /**
   * Value plus why. Server-side only — `reason` and `ruleId` say which rule
   * matched, i.e. which segment the viewer is in, and must never be serialized.
   */
  async explain(key: string): Promise<FlagEvaluation> {
    const store = RequestContext.getStore();
    const cached = store?.featureEvaluations?.get(key) as FlagEvaluation | undefined;
    if (cached) return cached;

    const ctx = await this.requestContext();
    const buckets = this.requestBuckets();
    const evaluation = await this.evaluateIn(key, ctx, buckets);

    if (store) {
      store.featureEvaluations ??= new Map();
      store.featureEvaluations.set(key, evaluation);
    }
    return evaluation;
  }

  /** Every declared flag for the ambient request, as `key -> value`. */
  async all(): Promise<Record<string, FlagValue>> {
    const ctx = await this.requestContext();
    return await this.evaluateAllIn(ctx, this.requestBuckets(), { clientOnly: false });
  }

  /**
   * What the SSR payload carries: client-visible flags only, values only.
   *
   * The single function the dispatcher calls, and the only place the
   * server-only exclusion is applied — so "what reaches the browser" has one
   * answer in one place rather than a rule each caller has to remember.
   */
  async forClient(): Promise<Record<string, FlagValue>> {
    if (!this.config.enabled) return {};

    const ctx = await this.requestContext();
    const values = await this.evaluateAllIn(ctx, this.requestBuckets(), { clientOnly: true });
    this.warnIfOversized(Object.keys(values).length);
    return values;
  }

  /** Evaluation against an explicit subject, for jobs, cron and previews. */
  for(subject: FeatureSubject): FeatureScope {
    return new FeatureScope(this, contextFromSubject(subject));
  }

  /** @internal — shared by the ambient path and `FeatureScope`. */
  async evaluateIn(
    key: string,
    ctx: EvaluationContext,
    buckets: Map<string, number>,
  ): Promise<FlagEvaluation> {
    const declaration = this.declared.get(key);
    if (!declaration) {
      // Typed callers cannot reach this; an untyped one (a string from a
      // console command, an app whose `gemi.d.ts` did not resolve) can.
      return { value: null, reason: "unknown", ruleId: null };
    }

    const definition = await this.definitionFor(key);
    const evaluation = evaluateFlag(definition.flag, ctx, {
      declaredDefault: declaration.defaultValue,
      segments: this.config.segments,
      bucketBy: this.config.bucketBy,
      unavailable: definition.unavailable,
      buckets,
    });

    this.notify(key, evaluation, ctx);
    return evaluation;
  }

  /** @internal */
  async evaluateAllIn(
    ctx: EvaluationContext,
    buckets: Map<string, number>,
    options: { clientOnly: boolean },
  ): Promise<Record<string, FlagValue>> {
    const values: Record<string, FlagValue> = {};

    for (const [key, declaration] of this.declared) {
      if (options.clientOnly && declaration.isServerOnly) continue;
      values[key] = (await this.evaluateIn(key, ctx, buckets)).value;
    }

    return values;
  }

  private async definitionFor(
    key: string,
  ): Promise<{ flag: FeatureFlagDefinition | undefined; unavailable: boolean }> {
    if (!this.config.enabled) {
      // Not "unavailable": the application turned flags off deliberately, and
      // the right answer is every declared default, not an error state.
      return { flag: undefined, unavailable: false };
    }

    const snapshot = await this.store.get();
    return { flag: snapshot.flags.get(key), unavailable: snapshot.unavailable };
  }

  private async requestContext(): Promise<EvaluationContext> {
    const store = RequestContext.getStore();
    if (store?.featureContext) return store.featureContext as EvaluationContext;

    const ctx = await contextFromRequest(this.config, this.log);
    if (store) store.featureContext = ctx;
    return ctx;
  }

  private requestBuckets(): Map<string, number> {
    const store = RequestContext.getStore();
    if (!store) return new Map();
    store.featureBuckets ??= new Map();
    return store.featureBuckets;
  }

  private notify(key: string, evaluation: FlagEvaluation, ctx: EvaluationContext) {
    if (!this.config.onEvaluate) return;
    try {
      this.config.onEvaluate(key, evaluation, ctx);
    } catch (error) {
      // An exposure-logging hook must not break the render it observes.
      this.log(
        `The \`onEvaluate\` hook in app/config/features.ts threw for "${key}". ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private warnIfOversized(count: number) {
    if (this.warnedAboutSize || count <= this.config.maxClientFlags) return;
    this.warnedAboutSize = true;
    this.log(
      `${count} client-visible feature flags are embedded in every document. Mark the ones only the server reads with \`.serverOnly()\` to keep them out of the payload.`,
    );
  }
}

function collectDeclarations(
  router: ResolvedFeaturesConfig["router"],
  log: (message: string) => void,
): Map<string, FeatureFlag<FlagValue>> {
  if (!router) {
    // Silent on purpose. Feature flags are opt-in, so an application that never
    // configured them has not made a mistake — and this runs on every boot,
    // including every `gemi run` and every test that boots a kernel, where a
    // line on stderr about a feature nobody asked for is pure noise.
    return new Map();
  }

  const instance = router instanceof FeatureRouter ? router : new router();
  return flattenFeatures(instance);
}
