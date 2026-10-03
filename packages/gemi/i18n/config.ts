import { DEFAULT_TIME_ZONE } from "./formatter";
import type { Dictionary } from "./Dictionary";
import type { HttpRequest } from "../http/HttpRequest";

// Config key: `translation`. Derived from `I18nServiceProvider`.
export interface TranslationConfig {
  supportedLocales?: string[];
  defaultLocale?: string;
  /**
   * @deprecated Only for `Dictionary.create` dictionaries. A `defineDictionary`
   * dictionary needs no entry here — the component that reads it pulls it in,
   * and the bundler ships only the active locale.
   */
  prefetch?: Record<string, Array<Dictionary<any>>>;
  /** @deprecated Only for `Dictionary.create` dictionaries. See `prefetch`. */
  components?: Record<string, Dictionary<any>>;

  // Returning `null` falls back to gemi's own locale detection.
  detectLocale?: (req: HttpRequest) => string | null;
  onLocaleChange?: (locale: string) => Promise<void> | void;

  /**
   * The IANA time zone dates are formatted in by `useFormatter`,
   * `useDictionary(...).format` and `Lang.formatter()`. Defaults to `UTC`.
   *
   * One zone for server and browser alike, so a server-rendered date and its
   * hydrated copy print the same text. Override per call with
   * `format.date(value, { timeZone })`.
   */
  timeZone?: string;
  /**
   * Resolve the zone for one request, e.g. from a cookie or the signed-in
   * user's profile. Returning `null` (or a zone `Intl` does not know) falls back
   * to `timeZone`. Runs on the server; the result ships with the page.
   */
  detectTimeZone?: (req: HttpRequest) => string | null;
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
    timeZone: DEFAULT_TIME_ZONE,
    detectTimeZone: () => null,
  };
}
