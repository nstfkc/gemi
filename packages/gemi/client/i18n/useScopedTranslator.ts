import type { I18nDictionary } from "../rpc";
import type { IsEmptyObject } from "../../utils/type";
import { useContext } from "react";
import { I18nContext } from "./I18nContext";

type ParseTranslationParams<T extends string> =
  T extends `${infer _Start}{${infer Param}}${infer Rest}`
    ? { [K in Param]: string } & ParseTranslationParams<Rest>
    : {};

export function useScopedTranslator<T extends keyof I18nDictionary>(scope: T) {
  const { translations } = useContext(I18nContext);

  return <
    K extends keyof I18nDictionary[T],
    U extends Record<string, string> = ParseTranslationParams<
      I18nDictionary[T][K]["en"]
    >,
  >(
    key: K,
    ...args: IsEmptyObject<U> extends true ? [] : [params: U]
  ) => {
    const [params = {}] = args;
    const _scope = translations[scope];

    const translation = _scope?.[key as any];
    if (!translation) {
      return key;
    }
    return applyParams(translation, params);
  };
}

function applyParams<T extends string>(
  str: T,
  params: Record<string, string>,
): string {
  return str.replace(/{([^}]+)}/g, (_, key) => {
    const value = params[key];

    if (value === undefined) {
      throw new Error(`Missing parameter: ${key}`);
    }

    return value;
  });
}
