import { parseTranslation } from "../utils/parseTranslation";
import type { ParseTranslationParams, Prettify } from "../utils/type";

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

  render<K extends keyof T, U extends keyof T[K]>(
    key: K,
    locale: U,
    ...args: ParamsOrNever<Prettify<ParseTranslationParams<T[K][U]>>>
  ) {
    if (typeof window !== "undefined") {
      throw new Error("Cannot use render in the browser");
    }
    if (!this.dictionary?.[key]?.[locale]) {
      throw new Error(
        `Translation not found for ${String(key)} in ${String(locale)}`,
      );
    }
    return parseTranslation(this.dictionary[key][locale], args[0] ?? {});
  }

  static create<const T extends Translations>(name: string, translations: T) {
    return new Dictionary<T>(name, translations);
  }
}
