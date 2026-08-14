import type { FlagValue, Rule } from "../types";
import { FeatureFlagSource } from "./FeatureFlagSource";

/**
 * A row as this source lets you write it: either a bare value — sugar for "on,
 * serving this" — or the parts of a row you care about.
 */
export type StaticFlag =
  | FlagValue
  | {
      enabled?: boolean;
      offValue?: FlagValue;
      defaultValue?: FlagValue;
      rules?: Rule[];
      seed?: string;
      bucketBy?: string;
    };

/**
 * Flags from a plain object instead of a database.
 *
 * This is how a test pins a flag:
 *
 * ```ts
 * defineFeaturesConfig({
 *   source: new StaticFeatureFlagSource({
 *     "new-checkout": true,
 *     "pricing-page": { defaultValue: "control", rules: [{ id: "r", rollout: 50, value: "a" }] },
 *   }),
 * })
 * ```
 *
 * Deliberately **not** a stub that returns canned answers: the rows go through
 * the same normalization and the same evaluator the database source feeds. A
 * test written against it therefore exercises rule precedence, bucketing and the
 * kill switch for real, and a test that pins `"new-checkout": true` is asserting
 * about the same code path production runs.
 */
export class StaticFeatureFlagSource extends FeatureFlagSource {
  constructor(private readonly flags: Record<string, StaticFlag> = {}) {
    super();
  }

  async load(): Promise<Record<string, unknown>[]> {
    return Object.entries(this.flags).map(([key, flag]) => toRow(key, flag));
  }
}

function toRow(key: string, flag: StaticFlag): Record<string, unknown> {
  if (flag === null || typeof flag !== "object") {
    // A bare value means "on, and serving this" — the shape a test reaches for
    // when it just wants the feature turned on.
    return { key, enabled: true, defaultValue: flag, seed: key };
  }

  return {
    key,
    // An explicit `enabled: false` still works, but omitting it means on: a
    // config block that spells out rules and then does nothing because nobody
    // wrote `enabled: true` is a bad default for a testing affordance.
    enabled: flag.enabled ?? true,
    offValue: flag.offValue ?? null,
    defaultValue: flag.defaultValue ?? null,
    rules: flag.rules ?? [],
    seed: flag.seed ?? key,
    bucketBy: flag.bucketBy ?? null,
  };
}
