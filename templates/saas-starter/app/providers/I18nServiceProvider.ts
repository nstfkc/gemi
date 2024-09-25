import { I18nServiceProvider } from "gemi/http";
import { dictionary } from "@/app/i18n";

export default class extends I18nServiceProvider {
  defaultLocale = "en-US";
  supportedLocales = ["en-US", "es-ES"];
  dictionary = dictionary;
}
