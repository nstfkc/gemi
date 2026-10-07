import type { HttpRequest } from "../http/HttpRequest";
import type { Dictionary } from "./Dictionary";
import type { TranslationConfig } from "./config";
import { negotiateLocale, resolveLocale } from "./resolveLocale";
import {
  createFormatter,
  isValidTimeZone,
  type Formatter,
} from "./formatter";

export class Translator {
  static token = "translator";

  translations = {};
  isEnabled = false;

  constructor(public config: Required<TranslationConfig>) {
    // Fail at boot rather than on the first page that prints a date: `Intl`
    // throws a `RangeError` for a zone it does not know.
    if (!isValidTimeZone(this.config.timeZone)) {
      throw new Error(
        `translation.timeZone: "${String(this.config.timeZone)}" is not a time zone this runtime knows. Use an IANA name such as "UTC" or "Europe/Istanbul".`,
      );
    }

    const translations = {};

    for (const [route, dicArray] of Object.entries(this.config.prefetch)) {
      for (const locale of this.config.supportedLocales) {
        if (!translations[locale]) {
          translations[locale] = {};
        }
        translations[locale][route] = {};
        for (const dic of dicArray) {
          translations[locale][route][dic.name] = {};
          for (const [key, value] of Object.entries(dic.dictionary)) {
            this.isEnabled = true;
            translations[locale][route][dic.name][key] = value[locale];
          }
        }
      }
    }
    this.translations = translations;
  }

  /**
   * Whether the app does locale-aware routing and rendering at all.
   *
   * `isEnabled` only means the legacy `prefetch` config has dictionaries to
   * serve. An app on `defineDictionary` has an empty `prefetch` and declares
   * its locales through `supportedLocales` alone, so gating on `isEnabled`
   * leaves it without locale detection or a locale URL prefix. Both the render
   * path and the redirect read this, because when they disagreed a migrated app
   * rendered a non-default locale at `/` with no redirect and no `Vary` — one
   * cache fill away from serving that document to everyone.
   */
  get isLocaleAware(): boolean {
    return this.isEnabled || this.config.supportedLocales.length > 0;
  }

  get supportedLocales(): string[] {
    return this.config.supportedLocales;
  }

  get defaultLocale(): string {
    return this.config.defaultLocale;
  }

  get components(): Record<string, Dictionary<any>> {
    return this.config.components;
  }

  /** The configured zone; `UTC` unless `translation.timeZone` says otherwise. */
  get timeZone(): string {
    return this.config.timeZone;
  }

  /**
   * The zone dates are formatted in for this request: `detectTimeZone`'s
   * answer when it gives a zone `Intl` knows, the configured zone otherwise.
   * A bad value from a cookie must not take the page down, so it is ignored
   * rather than thrown.
   */
  detectTimeZone(req: HttpRequest<any, any> | null | undefined): string {
    if (req) {
      const detected = this.config.detectTimeZone(req);
      if (isValidTimeZone(detected)) {
        return detected;
      }
    }
    return this.config.timeZone;
  }

  /**
   * A formatter for `locale` (the default locale when omitted) in `timeZone`
   * (the configured zone when omitted). For server code outside a request —
   * jobs, emails. Inside a request, `Lang.formatter()` picks up the request's
   * locale and zone.
   */
  formatter(locale?: string, timeZone?: string): Formatter {
    return createFormatter({
      locale: locale || this.defaultLocale,
      timeZone: isValidTimeZone(timeZone) ? timeZone : this.timeZone,
    });
  }

  onLocaleChange(locale: string): Promise<void> | void {
    return this.config.onLocaleChange(locale);
  }

  detectLocale(req: HttpRequest<any, any>) {
    const fallbackLocale =
      this.config.defaultLocale ?? this.config.supportedLocales[0] ?? "en-US";
    const resolve = (tag: string | null | undefined) =>
      resolveLocale(tag, this.config.supportedLocales, this.config.defaultLocale);

    const detectedLocale = resolve(this.config.detectLocale(req));
    if (detectedLocale) {
      return detectedLocale;
    }

    const previousLocale = resolve(req.cookies.get("i18n-locale"));
    if (previousLocale) {
      return previousLocale;
    }

    // The best entry by `q` weight the app can serve, even by language alone
    // (`de-AT` → `de-DE`), wins.
    const acceptedLocale = negotiateLocale(
      req.headers.get("accept-language"),
      this.config.supportedLocales,
      this.config.defaultLocale,
    );
    if (acceptedLocale) {
      return acceptedLocale;
    }

    return fallbackLocale;
  }

  getPageTranslations(locale: string, scope: string) {
    if (this.translations[locale][scope]) {
      return this.translations[locale][scope];
    }
    return {};
  }
}
