import type { Dictionary } from "./Dictionary";
import type { HttpRequest } from "../http/HttpRequest";

// Config key: `translation`. Derived from `I18nServiceProvider`.
export interface TranslationConfig {
  supportedLocales?: string[];
  defaultLocale?: string;
  prefetch?: Record<string, Array<Dictionary<any>>>;
  components?: Record<string, Dictionary<any>>;

  // Returning `null` falls back to gemi's own locale detection.
  detectLocale?: (req: HttpRequest) => string | null;
  onLocaleChange?: (locale: string) => Promise<void> | void;
}

export function defineTranslationConfig(
  config: TranslationConfig,
): TranslationConfig {
  return config;
}

export function translationConfigDefaults(): Required<TranslationConfig> {
  return {
    supportedLocales: [],
    defaultLocale: "en-US",
    prefetch: {},
    components: {},
    detectLocale: () => null,
    onLocaleChange: (locale) => {
      console.log(`Locale changed to ${locale}`);
    },
  };
}
