import type { HttpRequest } from "../http/HttpRequest";
import type { Dictionary } from "./Dictionary";
import type { TranslationConfig } from "./config";
import { resolveLocale } from "./resolveLocale";

export class Translator {
  static token = "translator";

  translations = {};
  isEnabled = false;

  constructor(public config: Required<TranslationConfig>) {
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

    // Entries are in the browser's preference order; the first one the app can
    // serve, even by language alone (`de-AT` → `de-DE`), wins.
    const acceptLanguage = req.headers.get("accept-language") ?? "";
    for (const entry of acceptLanguage.split(",")) {
      const locale = resolve(entry);
      if (locale) {
        return locale;
      }
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
