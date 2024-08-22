import { useContext } from "react";
import { ClientRouterContext } from "./ClientRouterContext";
import type { UrlParser, ViewPaths } from "./types";
import { applyParams } from "../utils/applyParams";
import { I18nContext } from "./i18n/I18nContext";

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
  } = useContext(ClientRouterContext);
  const { fetchTranslations } = useContext(I18nContext);

  function action(pushOrReplace: "push" | "replace") {
    return async <T extends ViewPaths>(
      path: T,
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

      const components = getViewPathsFromPathname(path);

      const fetchUrlSearchParams = new URLSearchParams(urlSearchParams);
      fetchUrlSearchParams.set("json", "true");
      const fetchPath = [basePath, fetchUrlSearchParams.toString()].join("?");

      urlSearchParams.set("json", "true");

      if (shallow) {
        history?.[pushOrReplace](navigationPath);
        return;
      }

      const routePathname = getRoutePathnameFromHref(path);

      isNavigatingSubject.next(true);

      try {
        const [res] = await Promise.all([
          fetch(fetchPath, { signal: navigationAbortController.signal }),
          fetchTranslations(
            routePathname,
            undefined,
            navigationAbortController.signal,
          ),
          ...components.map((component) =>
            (window as any).loaders[component](),
          ),
        ]);

        if (res.ok) {
          const { data, directive = {}, is404 = false } = await res.json();
          if (directive?.kind === "Redirect") {
            if (directive?.path) {
              history.replace(directive.path);
            }
            return;
          }
          updatePageData(data);
          history?.[pushOrReplace](
            navigationPath,
            is404 ? { status: 404 } : {},
          );
          window.scrollTo(0, 0);
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
