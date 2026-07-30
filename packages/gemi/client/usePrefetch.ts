import { useCallback, useContext } from "react";

import { applyParams } from "../utils/applyParams";
import { ClientRouterContext } from "./ClientRouterContext";
import { I18nContext } from "./I18nContext";
import { useLocation } from "./useLocation";
import type { UrlParser, ViewPaths } from "./types";

type Search = Record<string, string | number | boolean | undefined | null>;

/**
 * A prefetch spends the visitor's data on a page they may never open, so it
 * stands down when they have asked for less of that or the connection cannot
 * spare it. `navigator.connection` only exists in Chromium — everywhere else
 * there is nothing to go on and prefetching proceeds.
 */
function connectionRefusesPrefetch() {
  const connection = (navigator as any)?.connection;
  if (!connection) {
    return false;
  }
  if (connection.saveData) {
    return true;
  }
  return ["slow-2g", "2g"].includes(connection.effectiveType);
}

type Options<T extends ViewPaths> =
  UrlParser<T> extends Record<string, never>
    ? {
        search?: Search;
        locale?: string;
      }
    : {
        search?: Search;
        params: UrlParser<T>;
        locale?: string;
      };

/**
 * Warms a route ahead of the navigation to it: its page data, its stylesheets
 * and its component chunks. A navigation that lands on a prefetched route
 * renders from the cached payload instead of waiting on a request.
 *
 * The URL is built exactly the way `useNavigate` builds it — the prefetch is
 * only ever used by a navigation that asks for the same one.
 */
export function usePrefetch() {
  const { prefetchRoute } = useContext(ClientRouterContext);
  const { defaultLocale } = useContext(I18nContext);
  const location = useLocation();

  const currentPathname = location.pathname;
  const currentSearch = location.search;
  const currentLocale = location.locale;

  return useCallback(
    async <T extends ViewPaths>(
      path: T | (string & {}),
      ...args: UrlParser<T> extends Record<string, never>
        ? [options?: Options<T>]
        : [options: Options<T>]
    ) => {
      if (typeof window === "undefined" || !prefetchRoute) {
        return;
      }

      if (connectionRefusesPrefetch()) {
        return;
      }

      const [options = {}] = args;
      const {
        search = {},
        params = {},
        locale = null,
      } = { params: {}, search: {}, locale: null, ...options };

      let localeSegment = locale ?? currentLocale;
      if (localeSegment === defaultLocale) {
        localeSegment = "";
      }

      const pathname = applyParams(path, params) || "/";
      // Matches `useNavigate`, which hands the search object straight to
      // `URLSearchParams` — the query string a click produces has to be the one
      // the payload was cached under.
      const queryString = new URLSearchParams(search as any).toString();
      const searchSegment = queryString.length > 0 ? `?${queryString}` : "";

      // The route already on screen has nothing to warm, and eagerly prefetched
      // links pointing back at it would just replay the current page's queries.
      if (pathname === currentPathname && searchSegment === currentSearch) {
        return;
      }

      await prefetchRoute({
        pathname,
        search: searchSegment,
        localeSegment: localeSegment ? `/${localeSegment}` : "",
      });
    },
    [
      prefetchRoute,
      defaultLocale,
      currentLocale,
      currentPathname,
      currentSearch,
    ],
  );
}
