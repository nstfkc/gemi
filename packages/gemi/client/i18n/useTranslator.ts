import type { I18nDictionary } from "../rpc";
import type { IsEmptyObject, ParseTranslationParams } from "../../utils/type";
import type {
  KeyAndValue,
  KeyAndValueToObject,
} from "../../internal/type-utils";
import { applyTranslationParams } from "../../utils/applyTranslationParams";
import { useContext } from "react";
import { I18nContext } from "./I18nContext";

type FlattenDictionary<T extends I18nDictionary> = {
  [K in keyof T]: {
    [K2 in keyof T[K]]: KeyAndValue<K2, T[K][K2]>;
  }[keyof T[K]];
}[keyof T];

type FlatI18nDictionary = KeyAndValueToObject<
  FlattenDictionary<I18nDictionary>
>;

export function useTranslator() {
  const { translations } = useContext(I18nContext);

  return <T extends keyof FlatI18nDictionary>(
    key: T,
    ...args: IsEmptyObject<
      ParseTranslationParams<FlatI18nDictionary[T]["default"]>
    > extends true
      ? []
      : [params: ParseTranslationParams<FlatI18nDictionary[T]["default"]>]
  ) => {
    const [params = {}] = args;
    for (const scope in translations) {
      if (translations[scope][key as any]) {
        return applyTranslationParams(translations[scope][key as any], params);
      }
    }
    return key;
  };
}
