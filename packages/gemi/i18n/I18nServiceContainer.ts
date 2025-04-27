import type { HttpRequest } from "../http";
import { ServiceContainer } from "../services/ServiceContainer";
import type { I18nServiceProvider } from "./I18nServiceProvider";

export class I18nServiceContainer extends ServiceContainer {
  static _name = "I18nServiceContainer";
  isEnabled = true;
  translations = {};
  supportedLocales: string[] = [];

  constructor(public service: I18nServiceProvider) {
    super();

    const translations = {};

    for (const [route, dicArray] of Object.entries(this.service.prefetch)) {
      for (const locale of this.service.supportedLocales) {
        if (!translations[locale]) {
          translations[locale] = {};
        }
        translations[locale][route] = {};
        for (const dic of dicArray) {
          translations[locale][route][dic.name] = {};
          for (const [key, value] of Object.entries(dic.dictionary)) {
            translations[locale][route][dic.name][key] = value[locale];
          }
        }
      }
    }
    this.translations = translations;
  }

  detectLocale(req: HttpRequest<any, any>) {
    const detectedLocale = this.service.detectLocale(req);
    if (this.supportedLocales.includes(detectedLocale)) {
      return detectedLocale;
    }

    const previousLocale = req.cookies.get("i18n-locale");

    const locale =
      previousLocale ?? (req.headers.get("accept-language") || "en-US");

    const [_locale] = locale.split(",");

    if (this.supportedLocales.includes(_locale)) {
      return _locale;
    }

    if (_locale.length === 2) {
      for (const supportedLocale of this.supportedLocales) {
        if (supportedLocale.startsWith(_locale)) {
          return supportedLocale;
        }
      }
    }

    const fallbackLocale =
      this.service.defaultLocale ?? this.supportedLocales[0];

    if (fallbackLocale) {
      return fallbackLocale;
    }

    return "en-US";
  }

  getPageTranslations(locale: string, scope: string) {
    if (this.translations[locale][scope]) {
      return this.translations[locale][scope];
    }
    return {};
  }
}
