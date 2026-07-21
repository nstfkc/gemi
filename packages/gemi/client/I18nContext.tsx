import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { ServerDataContext } from "./ServerDataProvider";

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
  defaultLocale: string;
}

export type CreateI18nDictionary<T> = {
  [K in keyof T]: T[K];
};

export const I18nContext = createContext({} as I18nContextValue);

export type Dictionary = Map<string, Map<string, Record<string, string>>>;

export const I18nProvider = (props: PropsWithChildren) => {
  const { i18n } = useContext(ServerDataContext);

  const [currentLocale, setCurrentLocale] = useState(i18n.currentLocale);

  const dictionary = useRef<Dictionary>(null);
  if (dictionary.current === null) {
    const initialDictionary: Dictionary = new Map();
    for (const [locale, value] of Object.entries(i18n?.dictionary ?? {})) {
      const components = new Map();
      for (const [component, translations] of Object.entries(value)) {
        components.set(component, translations);
      }
      initialDictionary.set(locale, components);
    }
    dictionary.current = initialDictionary;
  }

  const changeLocale = useCallback((locale: string) => {
    if (dictionary.current.has(locale)) {
      setCurrentLocale(locale);
    }
  }, []);

  const updateDictionary = useCallback(
    (
      translations: Record<string, Record<string, Record<string, string>>> = {},
      locale?: string,
    ) => {
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
    },
    [changeLocale],
  );

  const getComponentTranslations = useCallback(
    (component: string) => {
      return dictionary.current.get(currentLocale).get(component);
    },
    [currentLocale],
  );

  const fetchTranslations = useCallback(
    async (pathname: string, locale?: string, signal?: AbortSignal) => {
      if (Object.keys(i18n).length === 0) {
        return;
      }
      const response = await fetch(
        `/api/__gemi__/services/i18n/translations/${
          locale || currentLocale
        }${pathname === "/" ? "" : pathname}`,
        {
          signal,
        },
      );
      if (!response.ok) {
        return;
      }
      const translations = await response.json();
      updateDictionary(translations);
    },
    [i18n, currentLocale, updateDictionary],
  );

  const value = useMemo(
    () => ({
      getComponentTranslations,
      locale: currentLocale,
      changeLocale,
      updateDictionary,
      fetchTranslations,
      supportedLocales: i18n.supportedLocales,
      defaultLocale: i18n.defaultLocale,
    }),
    [
      getComponentTranslations,
      currentLocale,
      changeLocale,
      updateDictionary,
      fetchTranslations,
      i18n.supportedLocales,
      i18n.defaultLocale,
    ],
  );

  return (
    <I18nContext.Provider value={value}>
      {props.children}
    </I18nContext.Provider>
  );
};
