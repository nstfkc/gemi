import type { I18nDictionary } from "../rpc";
import type { IsEmptyObject, ParseTranslationParams } from "../../utils/type";
import { applyTranslationParams } from "../../utils/applyTranslationParams";
import { useContext } from "react";
import { I18nContext } from "./I18nContext";

export function useScopedTranslator<T extends keyof I18nDictionary>(
  scope: T extends "server" ? never : T,
) {
  const { translations } = useContext(I18nContext);

  return <
    K extends keyof I18nDictionary[T],
    U extends Record<string, string> = ParseTranslationParams<
      I18nDictionary[T][K]["default"]
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
    return applyTranslationParams(translation, params);
  };
}
