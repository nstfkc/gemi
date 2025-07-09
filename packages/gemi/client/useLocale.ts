import { useLocation } from "./useLocation";
import { useNavigate } from "./useNavigate";
import { useParams } from "./useParams";
import { useRouteData } from "./useRouteData";

const setCookie = async (locale: string) => {
  try {
    return await globalThis.cookieStore.set("i18n-locale", locale);
  } catch (err) {
    return await fetch(`/api/__gemi__/services/i18n/set-locale/${locale}`);
    // TODO: show unsuported browser error
    // console.log(err);
  }
};

export function useLocale() {
  const { i18n } = useRouteData();
  const { pathname, search } = useLocation();
  const { replace } = useNavigate();
  const params = useParams();

  const setLocale = async (locale: string) => {
    const urlSearchParams = new URLSearchParams(search);
    setCookie(locale).then(() => {
      replace(pathname, {
        locale,
        // TODO: fix: this conversion is wrong, because there can be multiple
        // search params with the same name
        search: Object.fromEntries(urlSearchParams.entries()),
        params,
      } as any);
    });
  };

  return [i18n.currentLocale, setLocale] as const;
}
