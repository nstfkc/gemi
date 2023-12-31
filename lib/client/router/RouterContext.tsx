import {
  ComponentType,
  LazyExoticComponent,
  PropsWithChildren,
  RefObject,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createBrowserHistory, History, Location } from "history";
import { createRouteMatcher } from "./routeMatcher";

export interface RouteDefinition {
  loader: (() => Promise<unknown>) | null;
  path: string;
  layout: string[];
  level: number;
}

interface RouteProps {
  level: number;
  Component: LazyExoticComponent<ComponentType<any>>;
  path: string;
}

export const Route = (props: PropsWithChildren<RouteProps>) => {
  const { Component } = props;
  const { routeDataRef, routerState } = useContext(RouterContext);

  const render = routerState.match === props.path;

  if (!render) {
    return null;
  }

  return (
    <Component
      router={routerState}
      data={routeDataRef.current?.get(props.path)}
    >
      {props.children}
    </Component>
  );
};

interface LayoutProps {
  Component: LazyExoticComponent<ComponentType<any>>;
  path: string;
  layoutName: string;
}

export const Layout = (props: PropsWithChildren<LayoutProps>) => {
  const { Component } = props;
  const { routes, layoutDataRef, routerState } = useContext(RouterContext);

  const currentRoute = routes.find((route) => route.path === routerState.match);
  if ([...currentRoute?.layout, ""].includes(props.layoutName)) {
    const data = layoutDataRef.current?.get(props.layoutName);

    return <Component data={data}>{props.children}</Component>;
  }

  return null;
};

interface RouterContextValue {
  location: Location;
  history: History;
  routes: RouteDefinition[];
  routeDataRef: RefObject<Map<string, Readonly<any>>>;
  layoutDataRef: RefObject<Map<string, Readonly<any>>>;
  routeMatcher: ReturnType<typeof createRouteMatcher>;
  routerState: {
    match: string;
    params: Record<string, string>;
    urlSearchParams: URLSearchParams;
  };
}

export const RouterContext = createContext({} as RouterContextValue);

let history: History;

if (!import.meta.env.SSR) {
  history = createBrowserHistory();
}

interface RouterProviderProps {
  initialPath: string;
  initialUrl: string;
  routes: RouteDefinition[];
  initialRouteData: Readonly<any>;
  initialLayoutData: Readonly<any>;
}

export const RouterProvider = (
  props: PropsWithChildren<RouterProviderProps>,
) => {
  const { initialPath, initialUrl, routes } = props;
  const routeDataRef = useRef(
    (() => {
      const map = new Map<string, Readonly<any>>();
      map.set(initialPath, props.initialRouteData);
      return map;
    })(),
  );

  const layoutDataRef = useRef(
    (() => {
      const map = new Map<string, Readonly<any>>();
      for (const [layoutName, data] of Object.entries(
        props.initialLayoutData,
      )) {
        map.set(layoutName, data);
      }
      return map;
    })(),
  );

  const routeMatcher = createRouteMatcher(routes.map((route) => route.path));

  const [location, setLocation] = useState<Location>({
    hash: "",
    key: "",
    pathname: initialUrl,
    search: "",
    state: {},
  });

  const url = new URL(initialUrl);

  const { match, params } = routeMatcher(url.pathname);
  const [routerState, setRouterState] = useState({
    match,
    params,
    urlSearchParams: url.searchParams,
  });

  useEffect(() => {
    history.listen((update) => {
      setLocation({ ...update.location });
      const { match, params } = routeMatcher(update.location.pathname);
      const searchParams = new URLSearchParams(update.location.search);
      setRouterState({ match, params, urlSearchParams: searchParams });
    });
  }, [routeMatcher]);

  return (
    <RouterContext.Provider
      value={{
        location,
        history,
        routes,
        routeDataRef,
        layoutDataRef,
        routerState,
        routeMatcher,
      }}
    >
      {props.children}
    </RouterContext.Provider>
  );
};
