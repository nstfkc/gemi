import { useContext } from "react";
import { I18nContext } from "./I18nContext";
import { ClientRouterContext, useLocation } from "../ClientRouterContext";

export function useLocale() {
  const { changeLocale, locale, fetchTranslations } = useContext(I18nContext);
  const { getRoutePathnameFromHref } = useContext(ClientRouterContext);
  const { pathname } = useLocation();

  const setLocale = async (locale: string) => {
    const x = getRoutePathnameFromHref(pathname);
    await fetchTranslations(x, locale);
    changeLocale(locale);
  };

  return [locale, setLocale] as const;
}
