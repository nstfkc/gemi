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

  /**
   * The time zone dates are formatted in for the current request: what
   * `translation.detectTimeZone` resolves, else `translation.timeZone`
   * (`UTC` by default). Outside a request, the configured zone.
   */
  static timeZone() {
    const translator = this.getFacadeRoot();
    return translator.detectTimeZone(RequestContext.getStore()?.req);
  }

  /**
   * A formatter bound to the current request's locale and time zone — the
   * same ones the page renders with, so a date in a flash message or an email
   * matches the one on screen.
   *
   * ```ts
   * Lang.formatter().date(order.createdAt, { dateStyle: "long" });
   * ```
   */
  static formatter(options: { locale?: string; timeZone?: string } = {}) {
    const translator = this.getFacadeRoot();
    return translator.formatter(
      options.locale ?? Lang.locale(),
      options.timeZone ?? Lang.timeZone(),
    );
  }

  /**
   * Sets the locale for the rest of this request and, unless `cookie` is
   * `false`, remembers it in the `i18n-locale` cookie for the next one.
   */
  static setLocale(locale = Lang.locale(), options: { cookie?: boolean } = {}) {
    const translator = this.getFacadeRoot();
    let _locale = locale;
    if (!translator.supportedLocales.includes(locale)) {
      _locale = translator.defaultLocale;
    }

    const store = RequestContext.getStore();

    if (options.cookie !== false) {
      store.setCookie("i18n-locale", _locale, {
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
        secure: false,
        httpOnly: false,
      });
    }

    // The cookie is for the *next* request. Without also recording it here,
    // `Lang.locale()` would keep answering with the locale this request arrived
    // under — so setting the locale would not change what the rest of the
    // request renders in, which is the one thing calling it implies.
    store.setLocale(_locale);

    return _locale;
  }
}
