import type { I18nDictionary } from "./rpc";
import type { ParseTranslationParams, Prettify } from "../utils/type";
import type { JSX } from "react";
import { parseTranslation } from "../utils/parseTranslation";
import { useRouteData } from "./useRouteData";

type Parser<T extends Record<string, string>> = Prettify<
  {
    [K in keyof T]: ParseTranslationParams<T[K]>;
  }[keyof T]
>;

type ParamsOrNever<T> = T extends Record<string, never>
  ? [params?: never]
  : [params: T];

/**
 * @deprecated Use `useDictionary(dict)` with a `defineDictionary` dictionary
 * declared next to the component. This resolves a dictionary by name through
 * the global `I18nDictionary` interface, which needs a `gemi.d.ts`
 * declaration, a central `app/i18n/index.ts`, and a hand-maintained `prefetch`
 * map naming every route's dictionaries — and it ships whatever that map says
 * whether the page reads it or not. Still supported; see `docs/i18n.md`.
 */
export function useTranslator<T extends keyof I18nDictionary>(component: T) {
  const { i18n } = useRouteData();

  function parse<
    K extends keyof I18nDictionary[T]["dictionary"],
    U extends Record<string, string> = I18nDictionary[T]["dictionary"][K],
  >(key: K, ...args: ParamsOrNever<Parser<U>>) {
    try {
      const translations = i18n.dictionary[i18n.currentLocale][component];
      const [params = {}] = args;
      return parseTranslation(translations[key as any], params);
    } catch (err) {
      console.error(
        `Unresolved translation Component:${component} key:${String(key)}`,
      );
      return String(key);
    }
  }

  parse.jsx = <
    K extends keyof I18nDictionary[T]["dictionary"],
    U extends Record<string, string> = I18nDictionary[T]["dictionary"][K],
  >(
    key: K,
    ...args: ParamsOrNever<Parser<U>>
  ) => {
    return parse(key, ...(args as any)) as unknown as JSX.Element;
  };

  return parse;
}
