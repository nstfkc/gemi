import { type History, type Location, createBrowserHistory } from "history";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { Subject } from "../utils/Subject";
import { URLPattern } from "urlpattern-polyfill";
import { ProgressManager } from "./ProgressManager";

interface ClientRouterContextValue {
  viewEntriesSubject: Subject<string[]>;
  history: History | null;
  updatePageData: (pageData: Record<string, any>) => void;
  getPageData: (key: string) => any;
  locationSubject: Subject<Location>;
  getScrollPosition: (path: string) => number;
  params: Record<string, string>;
  getViewPathsFromPathname: (pathname: string) => string[];
  getRoutePathnameFromHref: (href: string) => string | null;
  isNavigatingSubject: Subject<boolean>;
  setNavigationAbortController: (controller: AbortController) => void;
  progressManager: ProgressManager;
}

export const ClientRouterContext = createContext(
  {} as ClientRouterContextValue,
);

interface ClientRouterProviderProps {
  pathname: string;
  routeManifest: Record<string, string[]>;
  pageData: Record<string, any>;
  currentPath: string;
  params: Record<string, string>;
  searchParams: string;
  is404: boolean;
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
    pageData,
    params,
    searchParams,
  } = props;
  const [parameters, setParameters] = useState(params);
  const navigationAbortControllerRef = useRef(new AbortController());
  const [isNavigatingSubject] = useState(() => {
    return new Subject<boolean>(false);
  });

  const [progressManager] = useState(new ProgressManager(isNavigatingSubject));
  const pageDataRef = useRef(structuredClone(pageData));
  const scrollHistoryRef = useRef<Map<string, number>>(new Map());
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
    scrollHistoryRef.current.set(
      locationSubject.getValue().pathname,
      window.scrollY,
    );
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

    const [route] = sortedCandidates ?? [];
    return route;
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

  const updatePageData = (newPageData: Record<string, any>) => {
    const [key, value] = Object.entries(newPageData)[0];
    if (!pageDataRef.current?.[key]) {
      pageDataRef.current[key] = {};
    }

    pageDataRef.current[key] = value;
  };

  const getPageData = (key: string) => {
    return pageDataRef.current[locationSubject.getValue().pathname][key];
  };

  const setNavigationAbortController = (controller: AbortController) => {
    navigationAbortControllerRef.current.abort();
    navigationAbortControllerRef.current = controller;
  };

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
      }}
    >
      {children}
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
  const { locationSubject } = ctx;
  const [location, setLocation] = useState(locationSubject?.getValue());

  useLocationChange((newLocation) => {
    setLocation(newLocation);
  });

  return location;
}

export function useParams() {
  const { params } = useContext(ClientRouterContext);
  return params;
}
