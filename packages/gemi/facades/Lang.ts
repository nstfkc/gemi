import { Translator } from "../i18n/Translator";
import { RequestContext } from "../http/requestContext";
import { Facade } from "./Facade";

export class Lang extends Facade {
  static getFacadeAccessor() {
    return Translator;
  }

  static getSupportedLocales() {
    return this.getFacadeRoot().supportedLocales;
  }

  static getDefaultLocale() {
    return this.getFacadeRoot().defaultLocale;
  }

  static locale() {
    const translator = this.getFacadeRoot();
    const requestStore = RequestContext.getStore();
    if (requestStore) {
      return translator.detectLocale(requestStore.req);
    }

    return translator.defaultLocale;
  }

  static setLocale(locale = Lang.locale()) {
    const translator = this.getFacadeRoot();
    let _locale = locale;
    if (!translator.supportedLocales.includes(locale)) {
      _locale = translator.defaultLocale;
    }

    RequestContext.getStore().setCookie("i18n-locale", _locale, {
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      secure: false,
      httpOnly: false,
    });

    return _locale;
  }
}
