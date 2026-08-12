// The module, not the `../facades` barrel. A dictionary is the one server-side
// artifact a *component* test has to import — `<Page dictionaries={[…]}>` takes
// the app's real `app/i18n/index.ts` — and the barrel drags the whole facade
// set in behind it, including `Redis` and its `import { RedisClient } from
// "bun"`. Under a browser-targeted runner (vitest/jsdom) that specifier does
// not resolve, so importing the app's dictionaries failed to collect before it
// rendered anything. `Lang` itself only needs the translator and the request
// context.
import { Lang } from "../facades/Lang";
import { parseTranslation } from "../utils/parseTranslation";
import type {
  ParseTranslationParams,
  ParseTranslationParamsServer,
  Prettify,
} from "../utils/type";

type Translations = Record<string, Record<string, string>>;

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
    const { locale = Lang.locale(), params } = {
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

  /**
   * @deprecated Use `defineDictionary` from `gemi/client`, declared next to the
   * component that reads it. A dictionary made here has to be re-exported from
   * `app/i18n/index.ts` and listed against a route in the `prefetch` config,
   * and every locale of it stays resident whether a page uses it or not. Still
   * supported; see `docs/i18n.md`.
   */
  static create<const T extends Translations>(name: string, translations: T) {
    return new Dictionary<T>(name, translations);
  }

  static text<const T extends Record<string, string>, U extends keyof T>(
    content: T,
    ...args: Prettify<ParseTranslationParamsServer<T[U]>> extends Record<
      string,
      never
    >
      ? [args?: { locale?: U | (string & {}) }]
      : [
          args: {
            locale?: U | (string & {});
            params: Prettify<ParseTranslationParamsServer<T[U]>>;
          },
        ]
  ): string {
    const { locale = Lang.locale(), params } = { params: {}, ...args?.[0] };

    if (!content?.[locale]) {
      throw new Error(`Translation not found for ${String(locale)}`);
    }

    return parseTranslation(content[locale], params ?? {});
  }
}
