import { HttpRequest } from "./HttpRequest";

import type { Translations } from "../client/i18n/I18nContext";

export class I18nServiceProvider {
  dictionary: Translations = {};
  supportedLocales: string[] = [];
  defaultLocale = "en-US";

  async init() {}

  detectLocale(_req: HttpRequest) {
    return this.defaultLocale;
  }
}
