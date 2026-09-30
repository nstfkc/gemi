import {
  FeatureFlagSource,
  type FeatureWriteMeta,
  type FeatureWriteResult,
} from "./FeatureFlagSource";

/**
 * Switches from a plain object instead of a database.
 *
 * This is how a test turns a feature on:
 *
 * ```ts
 * defineFeaturesConfig({
 *   source: new StaticFeatureFlagSource({ "new-checkout": true }),
 * })
 * ```
 *
 * Deliberately **not** a stub that returns canned answers: these rows go through
 * the same store and the same evaluator the database source feeds. A test that
 * pins `"new-checkout": true` therefore still exercises the feature's own `when`
 * and `rollout`, which is the part worth testing — pinning the final answer
 * would assert about a code path production never runs.
 *
 * Writable, in memory, so `Features.set()` works against it in a test exactly
 * as it does against the table — including the actor, which it always records.
 * The object passed in is copied, never mutated.
 */
export class StaticFeatureFlagSource extends FeatureFlagSource {
  private readonly rows = new Map<string, Record<string, unknown>>();

  constructor(active: Record<string, boolean> = {}) {
    super();
    for (const [key, value] of Object.entries(active)) {
      this.rows.set(key, { key, active: value });
    }
  }

  async load(): Promise<Record<string, unknown>[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async write(key: string, active: boolean, meta: FeatureWriteMeta): Promise<FeatureWriteResult> {
    this.rows.set(key, { key, active, updatedBy: meta.actor, updatedAt: new Date() });
    return { actorRecorded: true };
  }
}
