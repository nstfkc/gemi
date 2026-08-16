import * as registry from "../../../orm/registry";
import { FeatureFlagSource, FeatureModelMissingError } from "./FeatureFlagSource";

/**
 * Reads the application's `FeatureFlag` table — one row per feature, carrying
 * one meaningful column.
 *
 * The model is resolved from the ORM registry **by name, at call time**, the way
 * `auth/UserProvider` resolves `User`. The framework cannot import a class the
 * application generates, and resolving lazily also means constructing this
 * source does not require the app's models to have been imported yet — only
 * loading does.
 */
export class DatabaseFeatureFlagSource extends FeatureFlagSource {
  constructor(readonly modelName: string = "FeatureFlag") {
    super();
  }

  /** Whether the application has registered the model at all. */
  get available(): boolean {
    return registry.has(this.modelName);
  }

  async load(): Promise<Record<string, unknown>[]> {
    if (!this.available) {
      throw new FeatureModelMissingError(this.modelName);
    }

    const model = registry.get<any>(this.modelName);

    // `asSystem` for the same reason auth uses it: features are read before
    // there is a user — on an anonymous page load, in a cron tick — and a policy
    // that denies by default would turn "nobody is signed in" into "no rows",
    // which silently switches every feature off for logged-out traffic.
    return await model.asSystem(() => model.findMany());
  }
}
