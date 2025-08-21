import { I18nServiceContainer } from "../i18n/I18nServiceContainer";
import { RequestContext } from "../http/requestContext";

export class I18n {
  static getSupportedLocales() {
    return I18nServiceContainer.use().service.supportedLocales;
  }

  static getDefaultLocale() {
    return I18nServiceContainer.use().service.defaultLocale;
  }

  static locale() {
    const container = I18nServiceContainer.use();
    const requestStore = RequestContext.getStore();
    if (requestStore) {
      return container.detectLocale(requestStore.req);
    }

    return container.service.defaultLocale;
  }

  static setLocale(locale = I18n.locale()) {
    const container = I18nServiceContainer.use();
    let _locale = locale;
    if (!container.service.supportedLocales.includes(locale)) {
      _locale = container.service.defaultLocale;
    }

    RequestContext.getStore().setCookie("i18n-locale", _locale, {
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      secure: false,
      httpOnly: false,
    });

    return _locale;
  }
}
