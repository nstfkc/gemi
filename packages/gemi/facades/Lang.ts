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
      // The locale this request actually resolved to, when something has
      // resolved one. `detectLocale` re-reads the *incoming* cookie and
      // `accept-language`, so it does not see `ctx.setLocale()` or the URL
      // locale segment: a visitor whose cookie says `en-US` opening `/tr/about`
      // gets a Turkish page whose server-rendered strings — flash messages,
      // breadcrumbs, an order-confirmation email — come back in English, with
      // nothing raised. Detection stays the fallback for requests where no
      // locale was resolved, which is every API route.
      return requestStore.locale ?? translator.detectLocale(requestStore.req);
    }

    return translator.defaultLocale;
  }

  static setLocale(locale = Lang.locale()) {
    const translator = this.getFacadeRoot();
    let _locale = locale;
    if (!translator.supportedLocales.includes(locale)) {
      _locale = translator.defaultLocale;
    }

    const store = RequestContext.getStore();

    store.setCookie("i18n-locale", _locale, {
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      secure: false,
      httpOnly: false,
    });

    // The cookie is for the *next* request. Without also recording it here,
    // `Lang.locale()` would keep answering with the locale this request arrived
    // under — so setting the locale would not change what the rest of the
    // request renders in, which is the one thing calling it implies.
    store.setLocale(_locale);

    return _locale;
  }
}
