import { KernelContext } from "../kernel/KernelContext";
import { ApiRouter } from "./ApiRouter";
import { HttpRequest } from "./HttpRequest";
import { I18nServiceProvider } from "./I18nServiceProvider";

class Router extends ApiRouter {
  routes = {
    "/translations": this.get(async (req = new HttpRequest()) => {
      const input = await req.input();
      const { scope, locale: forcedLocale } = input.toJSON() as {
        scope: string;
        locale: string;
      };
      const locale =
        forcedLocale ??
        KernelContext.getStore().i18nServiceContainer.detectLocale(req);

      const translations =
        KernelContext.getStore().i18nServiceContainer.getPageTranslations(
          locale,
          scope,
        );

      req.ctx.setHeaders(
        "Cache-Control",
        req.ctx.user
          ? "private, max-age=1200, must-revalidate"
          : "public, max-age=864000, must-revalidate",
      );

      req.ctx.setCookie("i18n-locale", locale, {
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      return {
        [locale]: translations,
      };
    }),
  };
}

export class I18nServiceContainer {
  constructor(private service: I18nServiceProvider) {}

  isEnabled = false;
  translations = new Map();
  supportedLocales: string[] = [];
  routers = {
    api: Router,
  };

  boot() {
    // await this.service.init();

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

    let supportedLocales = new Set<string>();
    for (const [key, value] of tmpStore.entries()) {
      this.translations.set(key, Object.fromEntries(value.entries()));
      supportedLocales.add(key.split(".")[0]);
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

    const [l] = locale.split(",");

    if (this.supportedLocales.includes(l)) {
      return l;
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
