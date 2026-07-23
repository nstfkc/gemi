import type { HttpRequest } from "../http/HttpRequest";
import type { Dictionary } from "./Dictionary";
import type { TranslationConfig } from "./config";

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
    const detectedLocale = this.config.detectLocale(req);
    if (this.config.supportedLocales.includes(detectedLocale)) {
      return detectedLocale;
    }

    const previousLocale = req.cookies.get("i18n-locale");
    const locale =
      previousLocale ?? (req.headers.get("accept-language") || fallbackLocale);

    const [_locale] = locale.split(",");

    if (this.config.supportedLocales.includes(_locale)) {
      return _locale;
    }

    if (_locale.length === 2) {
      for (const supportedLocale of this.config.supportedLocales) {
        if (supportedLocale.startsWith(_locale)) {
          return supportedLocale;
        }
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
