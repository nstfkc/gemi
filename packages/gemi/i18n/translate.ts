import { Lang } from "../facades";
import { parseTranslation } from "../utils/parseTranslation";
import type { ParseTranslationParamsServer, Prettify } from "../utils/type";
import type { DictionaryHandle } from "./defineDictionary";
import type { DictionaryTranslations } from "./dictionaryShape";

/**
 * Read one string from a `defineDictionary` dictionary outside React — a
 * controller, a job, an email template.
 *
 * Async because a bundled dictionary loads its locale on demand. Server code
 * does not go through the bundler, so in practice this resolves without ever
 * yielding; the `await` is what makes the same call work either way.
 *
 * Kept out of `defineDictionary.ts` on purpose: that module is imported by
 * components and has to stay free of the server facades this one needs.
 */
export async function translate<
  T extends DictionaryTranslations,
  K extends keyof T & string,
  U extends keyof T[K],
  R = Prettify<ParseTranslationParamsServer<T[K][U] & string>>,
>(
  dictionary: DictionaryHandle<T>,
  key: K,
  ...args: R extends Record<string, never>
    ? [args?: { locale?: U | (string & {}) }]
    : [args: { locale?: U | (string & {}); params: R }]
): Promise<string> {
  const { locale = Lang.locale(), params } = { params: {}, ...args[0] };
  const strings = await dictionary.load(String(locale));
  const template = strings[key];

  if (typeof template !== "string") {
    throw new Error(
      `Translation not found for "${key}" in "${String(locale)}" (dictionary ${dictionary.id})`,
    );
  }

  return parseTranslation(template, (params ?? {}) as any) as string;
}
