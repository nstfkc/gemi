import { useContext } from "react";
import { I18nContext } from "./I18nContext";
import { ClientRouterContext } from "./ClientRouterContext";
import { useLocation } from "./useLocation";

export function useLocale() {
  const { changeLocale, locale, fetchTranslations } = useContext(I18nContext);
  const { getRoutePathnameFromHref } = useContext(ClientRouterContext);
  const { pathname } = useLocation();

  const setLocale = async (locale: string) => {
    await fetchTranslations(getRoutePathnameFromHref(pathname), locale);
    changeLocale(locale);
  };

  return [locale, setLocale] as const;
}
