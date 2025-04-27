import { I18nServiceProvider } from "gemi/i18n";

export default class extends I18nServiceProvider {
  defaultLocale = "en-US";
  supportedLocales = ["en-US", "tr-TR"];
  prefetch = {
    "/": [],
    "/about": [],
  };
}
