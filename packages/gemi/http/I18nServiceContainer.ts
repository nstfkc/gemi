import { ServiceContainer } from "../services/ServiceContainer";
import { ApiRouter } from "./ApiRouter";
import { HttpRequest } from "./HttpRequest";
import { I18nServiceProvider } from "./I18nServiceProvider";

export class I18nRouter extends ApiRouter {
  middlewares = ["cache:private"];
  routes = {
    "/translations/:locale/:scope*": this.get(async () => {
      const req = new HttpRequest<any, any>();

      const scope = `/${req.params.scope ?? ""}`;
      const forcedLocale = req.params.locale;

      const locale =
        forcedLocale ?? I18nServiceContainer.use().detectLocale(req);

      const translations = I18nServiceContainer.use().getPageTranslations(
        locale,
        scope,
      );

      req.ctx().setCookie("i18n-locale", locale, {
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      return {
        [locale]: translations,
      };
    }),
  };
}

export class I18nServiceContainer extends ServiceContainer {
  static _name = "I18nServiceContainer";

  isEnabled = false;
  translations = new Map();
  supportedLocales: string[] = [];

  constructor(public service: I18nServiceProvider) {
    super();
    const tmpStore = new Map<string, Map<string, string>>();

    for (const [scope, translations] of Object.entries(
      this.service.dictionary,
    )) {
      for (const [key, translation] of Object.entries(translations)) {
        for (const [_locale, value] of Object.entries(translation)) {
          const locale =
            _locale === "default" ? this.service.defaultLocale : _locale;
          if (!tmpStore.has(`${locale}.${scope}`)) {
            tmpStore.set(`${locale}.${scope}`, new Map());
          }
          tmpStore.get(`${locale}.${scope}`)?.set(key, value);
          this.isEnabled = true;
        }
      }
    }

    const supportedLocales = new Set<string>(service.supportedLocales);
    for (const [key, value] of tmpStore.entries()) {
      this.translations.set(key, Object.fromEntries(value.entries()));
      const [locale] = key.split(".");
      if (!supportedLocales.has(locale)) {
        supportedLocales.add(locale);
      }
    }
    this.supportedLocales = Array.from(supportedLocales);
  }

  detectLocale(req: HttpRequest<any, any>) {
    const detectedLocale = this.service.detectLocale(req);
    if (this.supportedLocales.includes(detectedLocale)) {
      return detectedLocale;
    }

    const forcedLocale = req.cookies.get("i18n-locale");

    const locale =
      forcedLocale ?? (req.headers.get("accept-language") || "en-US");

    const [_locale] = locale.split(",");

    if (this.supportedLocales.includes(_locale)) {
      return _locale;
    }

    const fallbackLocale =
      this.service.defaultLocale ?? this.supportedLocales[0];

    if (fallbackLocale) {
      return fallbackLocale;
    }

    return "en-US";
  }

  getPageTranslations(locale: string, scope: string) {
    if (!scope) {
      return {};
    }
    const viewTranslations =
      this.translations.get(`${locale}.view:${scope}`) ?? {};
    const out = {
      [`view:${scope}`]: viewTranslations,
    };

    for (const [key] of this.translations.entries()) {
      const layoutKey = key.split(".")[1];

      if (!layoutKey.startsWith("layout:")) {
        continue;
      }
      const layoutScope = layoutKey.split(":")[1];

      if (scope?.startsWith(layoutScope)) {
        out[layoutKey] = this.translations.get(`${locale}.${layoutKey}`) ?? {};
      }
    }

    return out;
  }
}
