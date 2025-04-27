import type { I18nDictionary } from "./rpc";
import type { ParseTranslationParams, Prettify } from "../utils/type";
import { applyTranslationParams } from "../utils/applyTranslationParams";
import { useContext } from "react";
import { I18nContext } from "./I18nContext";

type Parser<T extends Record<string, string>> = {
  [K in keyof T]: ParseTranslationParams<T[K]>;
}[keyof T];

type ParamsOrNever<T> = T extends Record<string, never>
  ? [params?: never]
  : [params: T];

export function useTranslator<T extends keyof I18nDictionary>(component: T) {
  const { getComponentTranslations } = useContext(I18nContext);

  return <K extends keyof I18nDictionary[T]["dictionary"]>(
    key: K,
    ...args: ParamsOrNever<Prettify<Parser<I18nDictionary[T]["dictionary"][K]>>>
  ) => {
    try {
      const translations = getComponentTranslations(component);
      const [params = {}] = args;
      return applyTranslationParams(translations[key as any], params);
    } catch (err) {
      console.error(
        `Unresolved translation Component:${component} key:${String(key)}`,
      );
      return String(key);
    }
  };
}
