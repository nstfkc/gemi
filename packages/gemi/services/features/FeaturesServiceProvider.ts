import { Log } from "../../facades/Log";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { featuresConfigDefaults, type FeaturesConfig } from "./config";
import { FeatureManager } from "./FeatureManager";
import { DatabaseFeatureFlagSource } from "./sources/DatabaseFeatureFlagSource";

export class FeaturesServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(FeatureManager, () => {
      const config = withDefaults(
        featuresConfigDefaults(),
        this.app.config.get<FeaturesConfig>("features", {}),
      );

      // The default source is constructed by `featuresConfigDefaults()` with the
      // default model name, so a `model` override would otherwise be ignored
      // unless the app also replaced the source. Rebuild it here instead of
      // making every app that renames the table also know about the source.
      if (config.source instanceof DatabaseFeatureFlagSource && config.model !== config.source.modelName) {
        config.source = new DatabaseFeatureFlagSource(config.model);
      }

      return new FeatureManager(config, (message) => Log.warning(message));
    });
  }

  async boot() {
    const features = this.app.make(FeatureManager);
    if (!features.config.enabled) return;

    // Warmed at boot so the first request is served from memory rather than
    // paying for the cold load. Wrapped because a database that is not up yet
    // must not fail the boot — the store degrades to declared defaults and
    // recovers on its own once the next TTL elapses.
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
