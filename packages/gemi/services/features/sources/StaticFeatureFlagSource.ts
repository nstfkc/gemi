import { FeatureFlagSource } from "./FeatureFlagSource";

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
 */
export class StaticFeatureFlagSource extends FeatureFlagSource {
  constructor(private readonly active: Record<string, boolean> = {}) {
    super();
  }

  async load(): Promise<Record<string, unknown>[]> {
    return Object.entries(this.active).map(([key, active]) => ({
      key,
      active,
    }));
  }
}
