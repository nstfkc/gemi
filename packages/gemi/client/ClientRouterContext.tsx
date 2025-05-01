import { type Action, type History, createBrowserHistory } from "history";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { Subject } from "../utils/Subject";
// @ts-ignore
import { URLPattern } from "urlpattern-polyfill";
import { ProgressManager } from "./ProgressManager";
import { HttpReload } from "./HttpReload";
import { HttpClientContext } from "./HttpClientContext";
import type { Breadcrumb } from "./useBreadcrumbs";
import type { RouteState } from "./RouteStateContext";
import { I18nContext } from "./I18nContext";

declare global {
  interface Window {
    scrollHistory: Map<string, number>;
  }
}

interface ClientRouterContextValue {
  viewEntriesSubject: Subject<string[]>;
  history: History | null;
  updatePageData: (
    pageData: Record<string, unknown>,
    breadcrumbs: Record<string, Breadcrumb>,
  ) => void;
  getPageData: (key: string, pathname: string) => Record<string, unknown>;
  getScrollPosition: (path: string) => number;
  getViewPathsFromPathname: (pathname: string) => string[];
  getRoutePathnameFromHref: (href: string) => string | null;
  isNavigatingSubject: Subject<boolean>;
  setNavigationAbortController: (controller: AbortController) => void;
  progressManager: ProgressManager;
  fetchRouteCSS: (routePath: string) => Promise<void>;
  breadcrumbsCache: Map<string, Breadcrumb>;
  routerSubject: Subject<RouteState>;
  urlLocaleSegment: string | null;
}

export const ClientRouterContext = createContext(
  {} as ClientRouterContextValue,
);

interface ClientRouterProviderProps {
  pathname: string;
  routeManifest: Record<string, string[]>;
  cssManifest: Record<string, string[]>;
  pageData: Record<string, unknown>;
  currentPath: string;
  urlLocaleSegment: string | null;
  params: Record<string, string>;
  searchParams: string;
  is404: boolean;
  breadcrumbs: Record<string, Breadcrumb>;
}

export const ClientRouterProvider = (
  props: PropsWithChildren<ClientRouterProviderProps>,
) => {
  const {
    children,
    pathname,
    currentPath,
    is404,
    routeManifest,
    cssManifest,
    pageData,
    params,
    searchParams,
    breadcrumbs,
    urlLocaleSegment,
  } = props;
  const navigationAbortControllerRef = useRef(new AbortController());
  const [isNavigatingSubject] = useState(() => {
    return new Subject<boolean>(false);
  });

  const { supportedLocales, locale } = useContext(I18nContext);

  const { fetch, host } = useContext(HttpClientContext);

  const [progressManager] = useState(new ProgressManager(isNavigatingSubject));
  const pageDataRef = useRef(structuredClone(pageData));
  const scrollHistoryRef = useRef<Map<string, number>>(new Map());
  const breadcrumbsCache = useRef<Map<string, Breadcrumb>>(
    new Map(Object.entries(breadcrumbs)),
  );

  const initalViewEntries = is404
    ? ["404"]
    : (routeManifest[pathname] ?? ["404"]);
  const viewEntriesSubject = useRef(new Subject<string[]>(initalViewEntries));

  const [routerSubject] = useState(() => {
    return new Subject<RouteState>({
      views: initalViewEntries,
      params,
      search: searchParams,
      state: {},
      pathname,
      hash: "",
      action: null as Action | null,
      routePath: currentPath,
      locale,
    });
  });

  const [history] = useState<History | null>(() => {
    let history: History | null = null;

    if (typeof window !== "undefined") {
      history = createBrowserHistory();
    }
    return history;
  });

  const findMatchingRouteFromParams = useMemo(
    () => (pathname: string) => {
      let routePath = pathname.replace("/en-US", "").replace("/tr-TR", "");
      routePath = routePath === "" ? "/" : routePath;
      const candidates: string[] = [];
      for (const route of Object.keys(routeManifest)) {
        const urlPattern = new URLPattern({ pathname: route });
        if (urlPattern.test({ pathname: routePath })) {
          candidates.push(route);
        }
      }
      const sortedCandidates = candidates.sort((a, b) => {
        const x = a.split("/").length + a.split(":").length;
        const y = b.split("/").length + b.split(":").length;
        return x - y;
      });

      return (sortedCandidates ?? [])[0];
    },
    [routeManifest],
  );

  const getViewPathsFromPathname = useMemo(
    () => (pathname: string) => {
      const route = findMatchingRouteFromParams(pathname);
      return routeManifest[route] ?? [];
    },
    [findMatchingRouteFromParams, routeManifest],
  );

  const getRoutePathnameFromHref = useMemo(
    () => (href: string) => {
      const route = findMatchingRouteFromParams(href);
      return route;
    },
    [findMatchingRouteFromParams],
  );

  const getParams = useMemo(
    () => (pathname: string) => {
      const route = findMatchingRouteFromParams(pathname);
      const urlPattern = new URLPattern({ pathname: route });
      return urlPattern.exec({ pathname })?.pathname.groups ?? {};
    },
    [findMatchingRouteFromParams],
  );

  useEffect(() => {
    history?.listen(({ location, action }) => {
      if (!window.scrollHistory) {
        window.scrollHistory = new Map();
      }
      const { hash, pathname, search } = routerSubject.getValue();
      const key = [pathname, search, hash].join("");
      window.scrollHistory.set(key, window.scrollY);
      let _pathname = location.pathname;
      let _locale = null;
      for (const locale of supportedLocales) {
        if (_pathname.startsWith(`/${locale}`)) {
          _locale = locale;
          _pathname = _pathname.replace(`/${locale}`, "");
          break;
        }
      }
      _pathname = _pathname === "" ? "/" : _pathname;
      const routePath = getRoutePathnameFromHref(_pathname);
      routerSubject.next({
        views: getViewPathsFromPathname(_pathname),
        params: getParams(_pathname),
        search: location.search,
        state: location.state as Record<string, unknown>,
        pathname: _pathname,
        action,
        routePath,
        hash: location.hash,
        locale: _locale,
      });
    });
  }, [
    supportedLocales,
    history,
    routerSubject,
    getParams,
    getRoutePathnameFromHref,
    getViewPathsFromPathname,
  ]);

  const updatePageData = (
    newPageData: Record<string, unknown>,
    breadcrumbs: Record<string, Breadcrumb>,
  ) => {
    const [key, value] = Object.entries(newPageData)[0];
    if (!pageDataRef.current?.[key]) {
      pageDataRef.current[key] = {};
    }
    for (const b in breadcrumbs) {
      breadcrumbsCache.current.set(b, breadcrumbs[b]);
    }

    pageDataRef.current[key] = value;
  };

  const getPageData = (key: string, pathname: string) => {
    return pageDataRef.current[pathname]?.[key];
  };

  const setNavigationAbortController = (controller: AbortController) => {
    navigationAbortControllerRef.current.abort();
    navigationAbortControllerRef.current = controller;
  };

  const fetchRouteCSS = async (routePath: string) => {
    const views = routeManifest[routePath];
    if (!views) {
      return;
    }
    const cssFiles = views
      .flatMap((view) => {
        return cssManifest?.[view];
      })
      .filter(Boolean)
      .filter((file) => !document.getElementById(file));

    if (cssFiles.length === 0) {
      return;
    }

    async function fetchCSS(path: string) {
      const response = await fetch(`${host}/${path}`);
      const content = response.text();
      return {
        content,
        id: path,
      };
    }
    const result = await Promise.all(cssFiles?.map((file) => fetchCSS(file)));
    for (const { content, id } of result) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = await content;
      document.head.appendChild(style);
    }
  };

  return (
    <ClientRouterContext.Provider
      value={{
        isNavigatingSubject,
        getViewPathsFromPathname,
        history,
        getScrollPosition: (path: string) => {
          return scrollHistoryRef.current.get(path) || 0;
        },
        viewEntriesSubject: viewEntriesSubject.current,
        updatePageData,
        getPageData,
        getRoutePathnameFromHref,
        setNavigationAbortController,
        progressManager,
        fetchRouteCSS,
        breadcrumbsCache: breadcrumbsCache.current,
        routerSubject,
        urlLocaleSegment,
      }}
    >
      {children}
      {/* @ts-ignore */}
      {import.meta.hot && <HttpReload />}
    </ClientRouterContext.Provider>
  );
};
