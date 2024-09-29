import { HttpRequest } from "./HttpRequest";

import type { Translations } from "../client/i18n/I18nContext";
import { ServiceProvider } from "../services/ServiceProvider";

export class I18nServiceProvider extends ServiceProvider {
  dictionary: Translations = {};
  supportedLocales: string[] = [];
  defaultLocale = "en-US";

  async init() {}

  detectLocale(_req: HttpRequest) {
    return "";
  }

  boot() {}
}
