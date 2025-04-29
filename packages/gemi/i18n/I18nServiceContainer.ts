import type { HttpRequest } from "../http/HttpRequest";
import { ServiceContainer } from "../services/ServiceContainer";
import type { I18nServiceProvider } from "./I18nServiceProvider";

export class I18nServiceContainer extends ServiceContainer {
  static _name = "I18nServiceContainer";
  translations = {};
  isEnabled = false;
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
            this.isEnabled = true;
            translations[locale][route][dic.name][key] = value[locale];
          }
        }
      }
    }
    this.translations = translations;
  }

  detectLocale(req: HttpRequest<any, any>) {
    const fallbackLocale =
      this.service.defaultLocale ?? this.service.supportedLocales[0] ?? "en-US";
    const detectedLocale = this.service.detectLocale(req);
    if (this.service.supportedLocales.includes(detectedLocale)) {
      return detectedLocale;
    }

    const previousLocale = req.cookies.get("i18n-locale");
    const locale =
      previousLocale ?? (req.headers.get("accept-language") || fallbackLocale);

    const [_locale] = locale.split(",");

    if (this.service.supportedLocales.includes(_locale)) {
      return _locale;
    }

    if (_locale.length === 2) {
      for (const supportedLocale of this.service.supportedLocales) {
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
