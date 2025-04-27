import { ApiRouter, HttpRequest } from "../http";
import { I18nServiceContainer } from "./I18nServiceContainer";

export class I18nRouter extends ApiRouter {
  middlewares = ["cache:private,0,no-store"];
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
