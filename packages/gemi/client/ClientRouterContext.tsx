import {
  type History,
  type To,
  type Location,
  createBrowserHistory,
} from "history";
import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PropsWithChildren,
} from "react";
import { Subject } from "../utils/Subject";
import { ComponentsContext } from "./ComponentContext";
import { URLPattern } from "urlpattern-polyfill";

interface ClientRouterContextValue {
  viewEntriesSubject: Subject<string[]>;
  history: History | null;
  updatePageData: (pageData: Record<string, any>) => void;
  getPageData: (key: string) => any;
  locationSubject: Subject<Location>;
  getScrollPosition: (path: string) => number;
  params: Record<string, string>;
  getViewPathsFromPathname: (pathname: string) => string[];
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

  const getViewPathsFromPathname = (pathname: string) => {
    for (const [route, views] of Object.entries(routeManifest)) {
      const urlPattern = new URLPattern({ pathname: route });
      if (urlPattern.test({ pathname })) {
        return views;
      }
    }
    return [];
  };
  const getParams = (pathname: string) => {
    for (const route of Object.keys(routeManifest)) {
      const urlPattern = new URLPattern({ pathname: route });
      if (urlPattern.test({ pathname })) {
        return urlPattern.exec({ pathname })?.pathname.groups!;
      }
    }
    return {};
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

  return (
    <ClientRouterContext.Provider
      value={{
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

export function useSearchParams() {
  const { locationSubject, history } = useContext(ClientRouterContext);
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const setSearchParams = (
    newSearchParams:
      | URLSearchParams
      | ((searchParams: URLSearchParams) => URLSearchParams),
  ) => {
    let nextSearchParams = newSearchParams;
    if (typeof newSearchParams === "function") {
      nextSearchParams = newSearchParams(searchParams);
    }

    locationSubject.next({
      ...locationSubject.getValue(),
      search: nextSearchParams.toString(),
    });

    history?.push({
      search: nextSearchParams.toString(),
    });
  };

  return [searchParams, setSearchParams] as const;
}

export function useViewData() {}

export function useRouter() {
  const { updatePageData, history, getViewPathsFromPathname } =
    useContext(ClientRouterContext);
  const { viewImportMap } = useContext(ComponentsContext);
  return {
    push: async (to: To, state?: any) => {
      let path = "";
      let urlSearchParams: URLSearchParams;
      let hash = "";

      if (typeof to === "string") {
        const [_path, search = ""] = to.split("?");
        path = _path;
        urlSearchParams = new URLSearchParams(search);
        urlSearchParams.set("json", "true");
      } else {
        const { hash: _hash, pathname, search } = to;
        urlSearchParams = new URLSearchParams(search);
        urlSearchParams.set("json", "true");
        path = pathname;
        hash = _hash;
      }

      const components = getViewPathsFromPathname(path);

      const fetchPath = `${path}?${urlSearchParams.toString()}${hash}`;
      const [res] = await Promise.all([
        fetch(fetchPath),
        ...components.map((component) => (window as any).loaders[component]()),
      ]);

      if (res.ok) {
        const { data, is404 = false } = await res.json();

        updatePageData(data);
        history?.push(to, is404 ? { status: 404 } : state);
        window.scrollTo(0, 0);
      }
    },
  };
}

export const Link = (
  props: Omit<ComponentProps<"a">, "href"> & { href: To },
) => {
  const { href, onClick, ...rest } = props;
  const { push } = useRouter();
  const { pathname } = useLocation();
  let path = "";
  if (typeof href === "string") {
    path = `${href}`;
  } else {
    const { hash, pathname, search } = href;
    const urlSearchParams = new URLSearchParams(search);
    path = `${pathname}${urlSearchParams.toString()}${hash}`;
  }

  const p = typeof href === "string" ? href : href.pathname;

  return (
    <a
      data-active={p === pathname}
      href={path}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
        startTransition(() => {
          push(href);
        });
      }}
      {...rest}
    />
  );
};
