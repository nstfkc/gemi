import { ApiRouter, HttpRequest } from "../http";
import { app } from "../foundation/app";
import { Translator } from "./Translator";

export class I18nRouter extends ApiRouter {
  middlewares = ["cache:private,0,no-store"];
  routes = {
    "/set-locale/:locale": this.get(async () => {
      const req = new HttpRequest<any, any>();
      const locale = req.params.locale;
      console.log(`Setting locale to ${locale}`);
      req.ctx().setCookie("i18n-locale", locale);
      await app(Translator).onLocaleChange(locale);
      return { locale };
    }),
    "/translations/:locale/:scope*": this.get(async () => {
      const req = new HttpRequest<any, any>();

      const scope = `/${req.params.scope ?? ""}`;
      const forcedLocale = req.params.locale;

      const translator = app(Translator);
      const locale = forcedLocale ?? translator.detectLocale(req);

      const translations = translator.getPageTranslations(locale, scope);

      req.ctx().setCookie("i18n-locale", locale, {
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      return {
        [locale]: translations,
      };
    }),
  };
}
