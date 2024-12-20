import {
  createContext,
  type PropsWithChildren,
  useContext,
  useState,
} from "react";
import { ServerDataContext } from "../ServerDataProvider";
import { HttpClientContext } from "../HttpClientContext";

type TranslationScope = Record<string, string>;
type TranslationScopes = Record<string, TranslationScope>;
export type Translations = Record<string, TranslationScopes>;

interface I18nContextValue {
  locale: string;
  changeLocale: (locale: string) => void;
  updateDictionary: (
    translations: Record<string, Record<string, Record<string, string>>>,
  ) => void;
  translations: TranslationScopes;
  fetchTranslations: (
    pathname: string,
    locale?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export const I18nContext = createContext({} as I18nContextValue);

interface I18nProviderProps {}

export type Dictionary = Map<string, Map<string, Record<string, string>>>;

export const I18nProvider = (props: PropsWithChildren<I18nProviderProps>) => {
  const { i18n } = useContext(ServerDataContext);
  const { fetch, host } = useContext(HttpClientContext);

  const [currentLocale, setCurrentLocale] = useState(i18n.currentLocale);

  const [dictionary] = useState<Dictionary>(() => {
    const dictionary = new Map();
    for (const [locale, value] of Object.entries(i18n.dictionary)) {
      const scopes = new Map();
      for (const [scope, translations] of Object.entries(value)) {
        scopes.set(scope, translations);
      }
      dictionary.set(locale, scopes);
    }
    return dictionary;
  });

  const [currentTranslations, setCurrentTranslations] =
    useState<TranslationScopes>(() => {
      if (!dictionary.has(currentLocale)) {
        return {};
      }
      return Object.fromEntries(dictionary.get(currentLocale).entries());
    });

  function updateDictionary(
    translations: Record<string, Record<string, Record<string, string>>> = {},
  ) {
    for (const [locale, value] of Object.entries(translations)) {
      if (!dictionary.has(locale)) {
        dictionary.set(locale, new Map());
      }
      const scopes = dictionary.get(locale);
      for (const [scope, translations] of Object.entries(value)) {
        if (!scopes.has(scope)) {
          scopes.set(scope, {});
        }
        scopes.set(scope, translations);
      }
    }
    setCurrentTranslations(
      Object.fromEntries(dictionary.get(currentLocale).entries()),
    );
  }

  const changeLocale = (locale: string) => {
    if (dictionary.has(locale)) {
      setCurrentLocale(locale);
      setCurrentTranslations(
        Object.fromEntries(dictionary.get(locale).entries()),
      );
    }
  };

  const fetchTranslations = async (
    pathname: string,
    locale?: string,
    signal?: AbortSignal,
  ) => {
    if (Object.keys(i18n).length === 0) {
      return;
    }
    const response = await fetch(
      `${host}/api/__gemi__/services/i18n/translations?scope=${pathname}&locale=${
        locale || currentLocale
      }`,
      {
        signal,
      },
    );
    const translations = await response.json();
    updateDictionary(translations);
  };

  return (
    <I18nContext.Provider
      value={{
        locale: currentLocale,
        translations: currentTranslations,
        changeLocale,
        updateDictionary,
        fetchTranslations,
      }}
    >
      {props.children}
    </I18nContext.Provider>
  );
};
