import { Log } from "../../facades/Log";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { featuresConfigDefaults, type FeaturesConfig } from "./config";
import { FeatureManager } from "./FeatureManager";
import { DatabaseFeatureFlagSource } from "./sources/DatabaseFeatureFlagSource";

export class FeaturesServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(FeatureManager, () => {
      const declared = this.app.config.get<FeaturesConfig>("features", {});
      const config = withDefaults(featuresConfigDefaults(), declared);

      // The default source is constructed by `featuresConfigDefaults()` with the
      // default model name, so a `model` override would otherwise be ignored
      // unless the app also replaced the source. Rebuild it here instead of
      // making every app that renames the table also know about the source.
      //
      // Keyed on what the *application* wrote, not on the merged values. The
      // merged `model` is always set — it defaults to `"FeatureFlag"` — so
      // comparing it against the source's name would fire for an app that
      // configured only `source: new DatabaseFeatureFlagSource("Flags")`,
      // throwing that source away and pointing the replacement at a table the
      // app never mentioned. Every feature would then read off with nothing to
      // explain why.
      //
      // An explicit `source` always wins: it is the more specific statement, and
      // it is the only one of the two that can name something other than the
      // local table.
      if (declared?.model !== undefined && declared?.source === undefined) {
        config.source = new DatabaseFeatureFlagSource(declared.model);
      } else if (
        declared?.model !== undefined &&
        declared.source instanceof DatabaseFeatureFlagSource &&
        declared.source.modelName !== declared.model
      ) {
        Log.warning(
          `app/config/features.ts sets \`model: "${declared.model}"\` and a source reading "${declared.source.modelName}". The source wins; drop \`model\` to silence this.`,
        );
      }

      return new FeatureManager(config, (message) => Log.warning(message));
    });
  }

  async boot() {
    const features = this.app.make(FeatureManager);
    if (!features.config.enabled) return;

    // Warmed at boot so the first request is served from memory rather than
    // paying for the cold load. Wrapped because a database that is not up yet
    // must not fail the boot — the store fails closed, every feature reads off,
    // and it recovers on its own once the next TTL elapses.
    try {
      await features.refresh();
    } catch (error) {
      Log.error(
        `Could not warm the feature flag cache at boot. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
