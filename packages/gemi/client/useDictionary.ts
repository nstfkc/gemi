import { use, useContext, type JSX } from "react";
import type { DictionaryHandle } from "../i18n/defineDictionary";
import { setActiveLocale } from "../i18n/dictionaryRegistry";
import type { DictionaryTranslations } from "../i18n/dictionaryShape";
import { parseTranslation } from "../utils/parseTranslation";
import type { ParseTranslationParams, Prettify } from "../utils/type";
import { DictionarySinkContext } from "./DictionarySinkContext";
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
 * Read a dictionary declared with `defineDictionary`, next to the component
 * that uses it.
 *
 * ```tsx
 * const t = useDictionary(homeDict);
 * t("title", { name });
 * ```
 *
 * Keys and interpolation params come straight from the literal — there is no
 * name string to keep in sync and no `gemi.d.ts` augmentation.
 *
 * Normally this resolves without suspending: the server seeds the strings it
 * rendered with into the hydration payload, and the router warms a view's
 * dictionaries while it is already loading that view's chunks. It falls back to
 * suspending on the locale's chunk when neither happened — a dictionary inside
 * a `lazy()` subtree, or the first render after a locale switch.
 *
 * Replaces `useTranslator`, which is deprecated.
 */
export function useDictionary<const T extends DictionaryTranslations>(
  dictionary: DictionaryHandle<T>,
) {
  const { i18n } = useRouteData();
  const sink = useContext(DictionarySinkContext);
  // An app with i18n switched off still renders dictionaries — fall back to the
  // source language rather than blowing up on an empty `i18n` payload.
  const locale = i18n?.currentLocale ?? dictionary.locales[0];
  // Tells the view loader which locale's chunks to warm on the next
  // navigation. `__GEMI_DATA__` only knows the locale the document loaded in.
  setActiveLocale(locale);

  // `loadForRender`, not the plain loader: a rejected locale chunk must not
  // rethrow out of `use()` and take the route down. It degrades to no strings,
  // and the per-key lookup below falls back to the key — what `useTranslator`
  // did. Called on the handle rather than the registry so a dictionary declared
  // at module scope survives the registry being reset under it.
  const pending = dictionary.loadForRender(locale);
  const strings = pending instanceof Promise ? use(pending) : pending;

  // Reported from the render phase, and deliberately so: on the server the
  // strings have to reach the document before the segment that used them is
  // revealed, or hydration would find them missing and refetch. The sink
  // de-duplicates, and it is null in the browser.
  sink?.use(dictionary.id, locale, strings);

  // Annotated `string` rather than inferred: `parseTranslation` returns `any`
  // (it hands back a JSX element on the `t.jsx` path), and letting that leak
  // through would silently defeat the key and param checking below — every
  // call site would typecheck against `any`.
  function parse<K extends keyof T & string, U extends T[K] = T[K]>(
    key: K,
    ...args: ParamsOrNever<Parser<U extends Record<string, string> ? U : never>>
  ): string {
    const template = strings[key];
    if (typeof template !== "string") {
      console.error(
        `Unresolved translation key:${key} locale:${locale} dictionary:${dictionary.id}`,
      );
      return key;
    }
    const [params = {}] = args;
    return parseTranslation(template, params as any) as string;
  }

  parse.jsx = <K extends keyof T & string, U extends T[K] = T[K]>(
    key: K,
    ...args: ParamsOrNever<Parser<U extends Record<string, string> ? U : never>>
  ) => {
    return parse(key, ...(args as any)) as unknown as JSX.Element;
  };

  return parse;
}
