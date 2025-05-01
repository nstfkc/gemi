import {
  createContext,
  type PropsWithChildren,
  useContext,
  useRef,
  useState,
} from "react";
import { ServerDataContext } from "./ServerDataProvider";
import { HttpClientContext } from "./HttpClientContext";

type TranslationScope = Record<string, string>;
type TranslationScopes = Record<string, TranslationScope>;
export type Translations = Record<string, TranslationScopes>;

interface I18nContextValue {
  locale: string;
  changeLocale: (locale: string) => void;
  updateDictionary: (
    translations: Record<string, Record<string, Record<string, string>>>,
    locale?: string,
  ) => void;
  fetchTranslations: (
    pathname: string,
    locale?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  getComponentTranslations: (key: string) => Record<string, string>;
  supportedLocales: string[];
}

export type CreateI18nDictionary<T> = {
  [K in keyof T]: T[K];
};

export const I18nContext = createContext({} as I18nContextValue);

export type Dictionary = Map<string, Map<string, Record<string, string>>>;

export const I18nProvider = (props: PropsWithChildren) => {
  const { i18n } = useContext(ServerDataContext);
  const { fetch, host } = useContext(HttpClientContext);

  const [currentLocale, setCurrentLocale] = useState(i18n.currentLocale);

  const dictionary = useRef<Dictionary>(
    (() => {
      const dictionary = new Map();
      for (const [locale, value] of Object.entries(i18n?.dictionary ?? {})) {
        const components = new Map();
        for (const [component, translations] of Object.entries(value)) {
          components.set(component, translations);
        }
        dictionary.set(locale, components);
      }
      return dictionary;
    })(),
  );

  function updateDictionary(
    translations: Record<string, Record<string, Record<string, string>>> = {},
    locale?: string,
  ) {
    for (const [locale, value] of Object.entries(translations)) {
      if (!dictionary.current.has(locale)) {
        dictionary.current.set(locale, new Map());
      }
      const scopes = dictionary.current.get(locale);
      for (const [scope, translations] of Object.entries(value)) {
        if (!scopes.has(scope)) {
          scopes.set(scope, {});
        }
        scopes.set(scope, translations);
      }
    }
    changeLocale(locale);
  }

  const changeLocale = (locale: string) => {
    if (dictionary.current.has(locale)) {
      setCurrentLocale(locale);
    }
  };

  const getTranslations = (locale: string) => {
    return (component: string) => {
      return dictionary.current.get(locale).get(component);
    };
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
      `${host}/api/__gemi__/services/i18n/translations/${
        locale || currentLocale
      }${pathname === "/" ? "" : pathname}`,
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
        getComponentTranslations: getTranslations(currentLocale),
        locale: currentLocale,
        changeLocale,
        updateDictionary,
        fetchTranslations,
        supportedLocales: i18n.supportedLocales,
      }}
    >
      {props.children}
    </I18nContext.Provider>
  );
};
