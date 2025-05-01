import { useContext } from "react";
import { I18nContext } from "./I18nContext";
import { ClientRouterContext } from "./ClientRouterContext";
import { useLocation } from "./useLocation";
import { useNavigate } from "./useNavigate";

export function useLocale() {
  const { changeLocale, locale, fetchTranslations } = useContext(I18nContext);
  const { getRoutePathnameFromHref } = useContext(ClientRouterContext);
  const { pathname, search } = useLocation();
  const { replace } = useNavigate();

  const setLocale = async (locale: string) => {
    const urlSearchParams = new URLSearchParams(search);
    changeLocale(locale);
    replace(pathname, {
      locale,
      // TODO: fix: this conversion is wrong, because there can be multiple
      // search params with the same name
      search: Object.fromEntries(urlSearchParams.entries()),
    });
    // await fetchTranslations(getRoutePathnameFromHref(pathname), locale);
  };

  return [locale, setLocale] as const;
}
