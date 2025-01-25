import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import type { UrlParser, ViewPaths } from "./types";
import { applyParams } from "../utils/applyParams";
import { I18nContext } from "./i18n/I18nContext";
import { QueryManagerContext } from "./QueryManagerContext";
import { HttpClientContext } from "./HttpClientContext";

type Options<T extends ViewPaths> =
  UrlParser<T> extends Record<string, never>
    ? {
        search?: Record<string, string | number | boolean | undefined | null>;
        shallow?: boolean;
      }
    : {
        search?: Record<string, string | number | boolean | undefined | null>;
        params: UrlParser<T>;
        shallow?: boolean;
      };

export function useNavigate() {
  const {
    updatePageData,
    history,
    getViewPathsFromPathname,
    getRoutePathnameFromHref,
    isNavigatingSubject,
    setNavigationAbortController,
    getScrollPosition,
    fetchRouteCSS,
  } = useContext(ClientRouterContext);
  const { updatePrefecthedData } = useContext(QueryManagerContext);
  const { fetchTranslations } = useContext(I18nContext);
  const { fetch, host } = useContext(HttpClientContext);

  function action(pushOrReplace: "push" | "replace") {
    return async <T extends ViewPaths>(
      path: T | (string & {}),
      ...args: UrlParser<T> extends Record<string, never>
        ? [options?: Options<T>]
        : [options: Options<T>]
    ) => {
      const navigationAbortController = new AbortController();
      setNavigationAbortController(navigationAbortController);

      const [options = {}] = args;
      const {
        search = {},
        params = {},
        shallow,
      } = {
        params: {},
        shallow: false,
        ...options,
      };
      const urlSearchParams = new URLSearchParams(search);

      const basePath = applyParams(path, params);

      const navigationPath = [
        applyParams(path, params),
        urlSearchParams.toString(),
      ].join("?");

      if (shallow) {
        history?.[pushOrReplace](navigationPath);
        return;
      }

      const components = getViewPathsFromPathname(path);

      const fetchUrlSearchParams = new URLSearchParams(urlSearchParams);
      fetchUrlSearchParams.set("json", "true");
      const fetchPath = [basePath, fetchUrlSearchParams.toString()].join("?");

      urlSearchParams.set("json", "true");

      const routePathname = getRoutePathnameFromHref(path);

      isNavigatingSubject.next(true);

      try {
        const [res] = await Promise.all([
          fetch(`${host}${fetchPath}`, {
            signal: navigationAbortController.signal,
          }),
          fetchRouteCSS(routePathname),
          fetchTranslations(
            routePathname,
            undefined,
            navigationAbortController.signal,
          ),
          ...components.map((component) => {
            if (!(window as any)?.loaders) return Promise.resolve();
            return (window as any)?.loaders[component]();
          }),
        ]);

        if (res.ok) {
          const {
            data,
            prefetchedData,
            breadcrumbs,
            directive = {},
            is404 = false,
          } = await res.json();
          if (directive?.kind === "Redirect") {
            if (directive?.path) {
              isNavigatingSubject.next(false);
              action("replace")(directive.path, { params: {} } as any);
            }

            return;
          }
          updatePageData(data, breadcrumbs);
          updatePrefecthedData(prefetchedData);

          history?.[pushOrReplace](
            navigationPath,
            is404 ? { status: 404 } : {},
          );
          setTimeout(() => {
            window.scrollTo(0, getScrollPosition(navigationPath));
          }, 1);
        }
      } catch (err) {
        isNavigatingSubject.next(false);
        // Do something
      }

      isNavigatingSubject.next(false);
    };
  }

  return {
    push: action("push"),
    replace: action("replace"),
  };
}
