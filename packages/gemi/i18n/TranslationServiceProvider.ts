import { ServiceProvider } from "../support/ServiceProvider";
import { withDefaults } from "../support/withDefaults";
import { Translator } from "./Translator";
import { translationConfigDefaults, type TranslationConfig } from "./config";

export class TranslationServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      Translator,
      () =>
        new Translator(
          withDefaults(
            translationConfigDefaults(),
            this.app.config.get<TranslationConfig>("translation", {}),
          ),
        ),
    );
  }
}
