import components from "@/app/i18n";
import { I18nServiceProvider } from "gemi/i18n";

export default class extends I18nServiceProvider {
  defaultLocale = "en-US";
  supportedLocales = ["en-US", "es", "de", "tr"];
  prefetch = {
    "/": [components.HomePage],
    "/about": [components.About],
  };
}
