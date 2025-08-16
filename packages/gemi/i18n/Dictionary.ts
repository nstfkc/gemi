import { I18n } from "../facades";
import { parseTranslation } from "../utils/parseTranslation";
import type { ParseTranslationParams, Prettify } from "../utils/type";
import { I18nServiceContainer } from "./I18nServiceContainer";

type Translations = Record<string, Record<string, string>>;

type ParamsOrNever<T> = T extends Record<string, never>
  ? [params?: never]
  : [params: T];

export class Dictionary<T extends Translations> {
  constructor(
    public name: string,
    public dictionary: T,
  ) {}

  reference(key: keyof T) {
    if (typeof window !== "undefined") {
      throw new Error("Cannot use reference in the browser");
    }
    if (!this.dictionary?.[key]) {
      throw new Error(`Translation not found for ${String(key)}`);
    }
    return this.dictionary[key];
  }

  render<
    K extends keyof T,
    U extends keyof T[K],
    R = Prettify<ParseTranslationParams<T[K][U]>>,
  >(
    key: K,
    ...args: R extends Record<string, never>
      ? [args?: { locale?: U | (string & {}) }]
      : [args: { locale?: U | (string & {}); params: R }]
  ) {
    const {
      locale = I18n.locale() ??
        I18nServiceContainer.use().service.defaultLocale ??
        "en-US",
      params,
    } = {
      params: {},
      ...args[0],
    };

    if (typeof window !== "undefined") {
      throw new Error("Cannot use render in the browser");
    }

    if (!this.dictionary?.[key]?.[locale]) {
      throw new Error(
        `Translation not found for ${String(key)} in ${String(locale)}`,
      );
    }
    return parseTranslation(this.dictionary[key][locale], params ?? {});
  }

  static create<const T extends Translations>(name: string, translations: T) {
    return new Dictionary<T>(name, translations);
  }
}
