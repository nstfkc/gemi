import { ApiRouter, HttpRequest } from "../http";
import { app } from "../foundation/app";
import { Translator } from "./Translator";

export class I18nRouter extends ApiRouter {
  middlewares = ["cache:private,0,no-store"];
  routes = {
    // Fires `onLocaleChange` and nothing else. The `i18n-locale` cookie is
    // written by the client before it navigates (`useLocale`), because the
    // navigation's own route-data request already has to carry it. Setting it
    // here as well could only ever undo that: this response would replace the
    // client's year-long cookie with a session one, and two switches in quick
    // succession put two responses in flight, where the later-landing one wins
    // regardless of which locale the user actually stopped on.
    "/set-locale/:locale": this.get(async () => {
      const req = new HttpRequest<any, any>();
      const locale = req.params.locale;
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
