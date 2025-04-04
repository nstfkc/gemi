import { type History, type Location, createBrowserHistory } from "history";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  cache,
  useMemo,
} from "react";
import { Subject } from "../utils/Subject";
// @ts-ignore
import { URLPattern } from "urlpattern-polyfill";
import { ProgressManager } from "./ProgressManager";
import { HttpReload } from "./HttpReload";
import { HttpClientContext } from "./HttpClientContext";
import { type Breadcrumb } from "./useBreadcrumbs";
import { I18nContext } from "./i18n/I18nContext";
import { applyParams } from "../utils/applyParams";

interface ClientRouterContextValue {
  viewEntriesSubject: Subject<string[]>;
  history: History | null;
  updatePageData: (
    pageData: Record<string, any>,
    breadcrumbs: Record<string, Breadcrumb>,
  ) => void;
  getPageData: (key: string) => any;
  locationSubject: Subject<Location>;
  getScrollPosition: (path: string) => number;
  params: Record<string, string>;
  getViewPathsFromPathname: (pathname: string) => string[];
  getRoutePathnameFromHref: (href: string) => string | null;
  isNavigatingSubject: Subject<boolean>;
  setNavigationAbortController: (controller: AbortController) => void;
  progressManager: ProgressManager;
  fetchRouteCSS: (routePath: string) => Promise<void>;
  breadcrumbsCache: Map<string, Breadcrumb>;
  getViewDataPromise: (
    componentPath: string,
  ) => (
    params: Record<string, string>,
    search: Record<string, string>,
  ) => Promise<[any, any, any]>;
}

export const ClientRouterContext = createContext(
  {} as ClientRouterContextValue,
);

interface ClientRouterProviderProps {
  pathname: string;
  routeManifest: Record<string, string[]>;
  cssManifest: Record<string, string[]>;
  pageData: Record<string, any>;
  currentPath: string;
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
  } = props;
  const { fetchTranslations } = useContext(I18nContext);
  const [parameters, setParameters] = useState(params);
  const navigationAbortControllerRef = useRef(new AbortController());
  const [isNavigatingSubject] = useState(() => {
    return new Subject<boolean>(false);
  });

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
  const [locationSubject] = useState(
    () =>
      new Subject<Location>({
        hash: "",
        pathname: currentPath,
        search: searchParams,
        state: {},
        key: "",
      }),
  );

  const [history] = useState<History | null>(() => {
    let history: History | null = null;

    // @ts-ignore
    if (typeof window !== "undefined") {
      history = createBrowserHistory();
    }
    return history;
  });

  const handleScroll = () => {
    const key = [
      `${locationSubject.getValue().pathname}?${locationSubject.getValue().search}`,
    ]
      .filter((item) => item.length > 0)
      .join("");

    scrollHistoryRef.current.set(key, window.scrollY);
  };

  const findMatchingRouteFromParams = (pathname: string) => {
    const candidates: string[] = [];
    for (const route of Object.keys(routeManifest)) {
      const urlPattern = new URLPattern({ pathname: route });
      if (urlPattern.test({ pathname })) {
        candidates.push(route);
      }
    }
    const sortedCandidates = candidates.sort((a, b) => {
      const x = a.split("/").length + a.split(":").length;
      const y = b.split("/").length + b.split(":").length;
      return x - y;
    });

    return (sortedCandidates ?? [])[0];
  };

  const getViewPathsFromPathname = (pathname: string) => {
    const route = findMatchingRouteFromParams(pathname);
    return routeManifest[route] ?? [];
  };

  const getRoutePathnameFromHref = (href: string) => {
    const route = findMatchingRouteFromParams(href);
    return route;
  };

  const getParams = (pathname: string) => {
    const route = findMatchingRouteFromParams(pathname);
    const urlPattern = new URLPattern({ pathname: route });
    return urlPattern.exec({ pathname })?.pathname.groups!;
  };

  useEffect(() => {
    history?.listen(({ location }) => {
      locationSubject.next(structuredClone(location));
      setParameters(getParams(location.pathname));
      viewEntriesSubject.current.next(
        (() => {
          if ((location.state as any)?.status === 404) {
            return ["404"];
          }
          return getViewPathsFromPathname(location.pathname);
        })(),
      );
    });

    window.addEventListener("scrollend", handleScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const updatePageData = (
    newPageData: Record<string, any>,
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

  const getPageData = (key: string) => {
    return pageDataRef.current[locationSubject.getValue().pathname]?.[key];
  };

  const setNavigationAbortController = (controller: AbortController) => {
    navigationAbortControllerRef.current.abort();
    navigationAbortControllerRef.current = controller;
  };

  const fetchRouteCSS = async (routePath: string) => {
    const views = routeManifest[routePath];
    const cssFiles = views
      .map((view) => {
        return cssManifest?.[view];
      })
      .flat()
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
    const result = await Promise.all(cssFiles.map((file) => fetchCSS(file)));
    for (const { content, id } of result) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = await content;
      document.head.appendChild(style);
    }
  };

  const getViewDataPromise = useMemo(() => {
    if (typeof window === "undefined") {
      return () => {
        return () => {
          return Promise.resolve([{}, {}, {}]) as any;
        };
      };
    }
    const viewsToRoutePath = new Map();
    for (const [key, value] of Object.entries(routeManifest)) {
      for (const view of value) {
        // TODO: fix this, layout components can be here multiple times.
        viewsToRoutePath.set(view, key);
      }
    }
    console.log(viewsToRoutePath);
    // TODO: this can have two arguments, layouts and view path
    // Maybe generating a unique key for each view using
    return (componentPath: string) =>
      (params: Record<string, string>, search: Record<string, string>) => {
        const routePathname = viewsToRoutePath.get(componentPath);
        const fn = cache((routePathname: string) => {
          const urlSearchParams = new URLSearchParams(search);

          const basePath = applyParams(routePathname, params);

          const fetchUrlSearchParams = new URLSearchParams(urlSearchParams);
          const fetchPath = [
            basePath + ".json",
            fetchUrlSearchParams.toString(),
          ]
            .filter((segment) => segment.length > 0)
            .join("?");
          return Promise.all([
            fetch(`${host}${fetchPath}`)
              .then((res) => res.json())
              .then(({ data }) => {
                return data;
              }),
            // fetchRouteCSS(routePathname),
            // fetchTranslations(routePathname, undefined),
          ]);
        });

        return fn(routePathname);
      };
  }, []);

  return (
    <ClientRouterContext.Provider
      value={{
        isNavigatingSubject,
        getViewPathsFromPathname,
        history,
        params: parameters,
        locationSubject,
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
        getViewDataPromise,
      }}
    >
      {children}
      {/* @ts-ignore */}
      {import.meta.hot && <HttpReload />}
    </ClientRouterContext.Provider>
  );
};

function useLocationChange(cb: (location: Location) => void) {
  const { locationSubject } = useContext(ClientRouterContext);
  useEffect(() => {
    cb(locationSubject.getValue());
    return locationSubject.subscribe(cb);
  }, []);
}

export function useLocation() {
  const ctx = useContext(ClientRouterContext);
  if (!ctx) {
    throw new Error("useLocation must be used within a ClientRouterProvider");
  }
  const [location, setLocation] = useState(ctx?.locationSubject?.getValue());

  useLocationChange((newLocation) => {
    setLocation(newLocation);
  });

  return location;
}
