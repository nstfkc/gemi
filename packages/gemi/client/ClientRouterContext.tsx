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
import { URLPattern } from "urlpattern-polyfill";

interface ClientRouterContextValue {
  viewEntriesSubject: Subject<string[]>;
  history: History | null;
  updatePageData: (pageData: Record<string, any>) => void;
  getPageData: (key: string) => any;
  locationSubject: Subject<Location>;
  getScrollPosition: (path: string) => number;
  params: Record<string, string>;
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
  } = props;
  const [parameters, setParameters] = useState(params);
  const pageDataRef = useRef(pageData);
  const scrollHistoryRef = useRef<Map<string, number>>(new Map());
  const initalViewEntries = is404
    ? ["404"]
    : routeManifest[pathname] ?? ["404"];
  const viewEntriesSubject = useRef(new Subject<string[]>(initalViewEntries));
  const locationSubject = useRef(
    new Subject<Location>({
      hash: "",
      pathname: currentPath,
      search: "",
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
      locationSubject.current.getValue().pathname,
      window.scrollY,
    );
  };

  useEffect(() => {
    history?.listen(({ location }) => {
      locationSubject.current.next(structuredClone(location));
      viewEntriesSubject.current.next(
        (() => {
          if ((location.state as any)?.status === 404) {
            return ["404"];
          }
          for (const [route, views] of Object.entries(routeManifest)) {
            const urlPattern = new URLPattern({ pathname: route });
            if (urlPattern.test({ pathname: location.pathname })) {
              setParameters(
                urlPattern.exec({ pathname: location.pathname })?.pathname
                  .groups!,
              );
              return views;
            }
          }
          return [];
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
    return pageDataRef.current[locationSubject.current.getValue().pathname][
      key
    ];
  };

  return (
    <ClientRouterContext.Provider
      value={{
        history,
        params: parameters,
        locationSubject: locationSubject.current,
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
  const { locationSubject } = useContext(ClientRouterContext);
  const [location, setLocation] = useState(locationSubject.getValue());

  useLocationChange((newLocation) => {
    setLocation(newLocation);
  });

  return location;
}

export function useParams() {
  const { params } = useContext(ClientRouterContext);
  return params;
}

export function useRouter() {
  const { updatePageData, history } = useContext(ClientRouterContext);
  return {
    push: async (to: To, state?: any) => {
      let path = "";
      if (typeof to === "string") {
        path = `${to}?json=true`;
      } else {
        const { hash, pathname, search } = to;
        const urlSearchParams = new URLSearchParams(search);
        urlSearchParams.set("json", "true");
        path = `${pathname}${urlSearchParams.toString()}${hash}`;
      }
      const res = await fetch(path);

      if (res.ok) {
        const { data } = await res.json();
        const is404 =
          (Object.values(data[to as any]) as any)[0]?.status === 404;
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
  let path = "";
  if (typeof href === "string") {
    path = `${href}`;
  } else {
    const { hash, pathname, search } = href;
    const urlSearchParams = new URLSearchParams(search);
    path = `${pathname}${urlSearchParams.toString()}${hash}`;
  }

  return (
    <a
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
