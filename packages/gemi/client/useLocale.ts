import { useContext } from "react";
import { I18nContext } from "./I18nContext";
import { useLocation } from "./useLocation";
import { useNavigate } from "./useNavigate";
import { useParams } from "./useParams";

export function useLocale() {
  const { changeLocale, locale } = useContext(I18nContext);
  const { pathname, search } = useLocation();
  const { replace } = useNavigate();
  const params = useParams();

  const setLocale = async (locale: string) => {
    const urlSearchParams = new URLSearchParams(search);
    changeLocale(locale);
    replace(pathname, {
      locale,
      // TODO: fix: this conversion is wrong, because there can be multiple
      // search params with the same name
      search: Object.fromEntries(urlSearchParams.entries()),
      params,
    } as any);
    // await fetchTranslations(getRoutePathnameFromHref(pathname), locale);
  };

  return [locale, setLocale] as const;
}
