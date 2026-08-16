import { RequestContext } from "../../http/requestContext";
import type { ResolvedFeaturesConfig } from "./config";
import { contextFromRequest, contextFromSubject, type FeatureSubject } from "./context";
import type { Feature, FeatureRegistry } from "./defineFeature";
import { evaluateFeature } from "./evaluate";
import { FeatureFlagStore } from "./FeatureFlagStore";
import type { FeatureContext, FeatureEvaluation } from "./types";

/**
 * Evaluation bound to one explicit context — what `Features.for(...)` returns.
 *
 * Exists because a job, a cron tick or an admin preview needs to ask "what would
 * *this* user see", and the ambient-request path cannot answer that.
 */
export class FeatureScope {
  constructor(
    private readonly manager: FeatureManager,
    private readonly ctx: FeatureContext,
  ) {}

  async enabled(key: string): Promise<boolean> {
    return (await this.explain(key)).value;
  }

  async explain(key: string): Promise<FeatureEvaluation> {
    return await this.manager.evaluateIn(key, this.ctx, new Map());
  }

  async all(): Promise<Record<string, boolean>> {
    return await this.manager.evaluateAllIn(this.ctx, new Map(), {
      clientOnly: false,
    });
  }
}

export class FeatureManager {
  static token = "features";

  readonly store: FeatureFlagStore;
  private readonly declared: FeatureRegistry;
  private warnedAboutSize = false;

  constructor(
    readonly config: ResolvedFeaturesConfig,
    private readonly log: (message: string) => void = () => {},
  ) {
    // Silent when nothing is configured. Features are opt-in, so an application
    // that never declared any has not made a mistake — and this runs on every
    // boot, including every `gemi run` and every test that boots a kernel, where
    // a line on stderr about a feature nobody asked for is pure noise.
    this.declared = config.features ?? {};
    this.store = new FeatureFlagStore(
      config.source,
      this.declared,
      Math.max(0, config.ttl) * 1000,
      this.log,
    );
  }

  /** The declarations, for a CLI or an admin surface. Server-side only. */
  declarations(): FeatureRegistry {
    return this.declared;
  }

  /** Reloads the snapshot in this process now. */
  async refresh(): Promise<void> {
    if (!this.config.enabled) return;
    // Nothing is declared, so no row could resolve to anything. Skipping the
    // query keeps an app that never adopted features from touching the database
    // — and from logging that it has no `FeatureFlag` model, which would be a
    // boot-time complaint about an unused feature.
    if (Object.keys(this.declared).length === 0) return;
    await this.store.refresh();
  }

  async enabled(key: string): Promise<boolean> {
    return (await this.explain(key)).value;
  }

  /**
   * Value plus why. Server-side only — `reason` says whether the viewer landed
   * in a rollout or was targeted by name, and must never be serialized.
   */
  async explain(key: string): Promise<FeatureEvaluation> {
    const store = RequestContext.getStore();
    const cached = store?.featureEvaluations?.get(key) as FeatureEvaluation | undefined;
    if (cached) return cached;

    const ctx = await this.requestContext();
    const evaluation = await this.evaluateIn(key, ctx, this.requestBuckets());

    if (store) {
      store.featureEvaluations ??= new Map();
      store.featureEvaluations.set(key, evaluation);
    }
    return evaluation;
  }

  /** Every declared feature for the ambient request, as `key -> boolean`. */
  async all(): Promise<Record<string, boolean>> {
    const ctx = await this.requestContext();
    return await this.evaluateAllIn(ctx, this.requestBuckets(), {
      clientOnly: false,
    });
  }

  /**
   * What the SSR payload carries: client-visible features only.
   *
   * The single function the dispatcher calls, and the only place the server-only
   * exclusion is applied — so "what reaches the browser" has one answer in one
   * place rather than a rule each caller has to remember.
   */
  async forClient(): Promise<Record<string, boolean>> {
    if (!this.config.enabled) return {};

    const ctx = await this.requestContext();
    const values = await this.evaluateAllIn(ctx, this.requestBuckets(), {
      clientOnly: true,
    });
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
    ctx: FeatureContext,
    buckets: Map<string, number>,
  ): Promise<FeatureEvaluation> {
    const feature: Feature | undefined = this.declared[key];
    if (!feature) {
      // Typed callers cannot reach this; an untyped one — a string from a
      // console command, an app whose `gemi.d.ts` did not resolve — can.
      return { value: false, reason: "undeclared" };
    }

    const { active, unavailable } = await this.switchFor(key);
    const evaluation = evaluateFeature(key, feature, ctx, {
      active,
      unavailable,
      buckets,
      warn: this.log,
    });

    this.notify(key, evaluation, ctx);
    return evaluation;
  }

  /** @internal */
  async evaluateAllIn(
    ctx: FeatureContext,
    buckets: Map<string, number>,
    options: { clientOnly: boolean },
  ): Promise<Record<string, boolean>> {
    const values: Record<string, boolean> = {};

    for (const [key, feature] of Object.entries(this.declared)) {
      if (options.clientOnly && feature.serverOnly) continue;
      values[key] = (await this.evaluateIn(key, ctx, buckets)).value;
    }

    return values;
  }

  private async switchFor(
    key: string,
  ): Promise<{ active: boolean | undefined; unavailable: boolean }> {
    if (!this.config.enabled) {
      // Not "unavailable": the application turned features off deliberately, and
      // the right answer is off everywhere, not an error state.
      return { active: false, unavailable: false };
    }

    const snapshot = await this.store.get();
    return {
      active: snapshot.active.get(key),
      unavailable: snapshot.unavailable,
    };
  }

  private async requestContext(): Promise<FeatureContext> {
    const store = RequestContext.getStore();
    if (store?.featureContext) return store.featureContext as FeatureContext;

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

  private notify(key: string, evaluation: FeatureEvaluation, ctx: FeatureContext) {
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
      `${count} client-visible features are embedded in every document. Mark the ones only the server reads with \`serverOnly: true\` to keep them out of the payload.`,
    );
  }
}
