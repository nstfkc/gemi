import {
  useContext,
  useEffect,
  useState,
  StrictMode,
  memo,
  useTransition,
} from "react";

import type { PropsWithChildren, ReactNode, ComponentType, lazy } from "react";

import { ServerDataContext } from "./ServerDataProvider";
import {
  ClientRouterContext,
  ClientRouterProvider,
} from "./ClientRouterContext";
import type { ComponentTree } from "./types";
import { ComponentsContext, ComponentsProvider } from "./ComponentContext";
import { QueryManagerProvider } from "./QueryManagerContext";
import { I18nProvider } from "./I18nContext";
import { WebSocketContextProvider } from "./WebsocketContext";
import { HttpClientContext } from "./HttpClientContext";
import { useNavigate } from "./useNavigate";
import {
  type PageData,
  type RouteState,
  RouteStateProvider,
} from "./RouteStateContext";
import { applyParams } from "../utils/applyParams";
import { Action } from "history";
import { useRouteData } from "./useRouteData";
import { updateMeta } from "./Head";
import { RouteTransitionProvider } from "./RouteTransitionProvider";
import { ThemeProvider } from "./ThemeProvider";

declare global {
  interface Window {
    scrollHistory: Map<string, number>;
    loaders: Record<string, () => void>;
  }
}

function restoreScroll(action: Action | null = null, _pathname = "no path") {
  if (action === null) {
    return;
  }

  const { pathname, search, hash } = window.location;

  const key = [pathname, search, hash].join("");
  const sh = window.scrollHistory;

  const scrollPosition = sh?.get(key);

  if (action !== Action.Pop) {
    window.scrollTo(0, 0);
  } else {
    // In dev mode the effect runs scroll restoration
    // will be called twice, this if statement prevents
    // scroll to top
    if (!scrollPosition) {
      return;
    }
    window.scrollTo(0, scrollPosition ?? 0);
  }

  sh?.delete(key);
}

interface RouteProps {
  componentPath: string;
  pathname: string;
  action: Action | null;
}

const Route = memo((props: PropsWithChildren<RouteProps>) => {
  const { componentPath, pathname, action, children } = props;
  const { viewImportMap } = useContext(ComponentsContext);
  const { data } = useRouteData();

  const componentData = data?.[pathname]?.[componentPath] ?? {};
  const Component = viewImportMap[componentPath];

  useEffect(() => {
    if (!children) {
      restoreScroll(action, componentPath);
    }
  }, [action, children, componentPath]);

  if (Component) {
    return <Component {...componentData}>{props.children}</Component>;
  }

  const NotFound = viewImportMap["404"];
  return <NotFound />;
});

const Tree = memo(
  (props: {
    action: Action;
    tree: ComponentTree;
    entries: string[];
    pathname: string;
  }) => {
    const { entries, tree, pathname, action } = props;

    return (
      <>
        {tree.map((node) => {
          const [path, subtree] = node;
          if (!entries.includes(path)) return null;
          if (subtree.length > 0) {
            return (
              <Route
                action={action}
                key={path}
                componentPath={path}
                pathname={pathname}
              >
                <Tree
                  action={action}
                  tree={subtree}
                  entries={entries}
                  pathname={pathname}
                />
              </Route>
            );
          }
          return (
            <Route
              action={action}
              key={path}
              componentPath={path}
              pathname={pathname}
            />
          );
        })}
      </>
    );
  },
);

const Routes = (props: { componentTree: ComponentTree }) => {
  const { componentTree } = props;
  const [isPending, startTransition] = useTransition();
  const [isFetching, setIsFetching] = useState(false);
  const { fetch, host } = useContext(HttpClientContext);

  const { routerSubject, fetchRouteCSS } = useContext(ClientRouterContext);

  const [transitionPath, setTransitionPath] = useState<[string, string]>([
    null,
    routerSubject?.getValue().pathname,
  ]);

  const {
    breadcrumbs,
    pageData,
    i18n,
    prefetchedData,
    appId: currentAppId,
  } = useContext(ServerDataContext);

  const [routeState, setRouteState] = useState<RouteState & PageData>({
    params: routerSubject?.getValue().params,
    search: routerSubject?.getValue().search,
    pathname: routerSubject?.getValue().pathname,
    views: routerSubject?.getValue().views,
    action: null,
    hash: routerSubject?.getValue().hash,
    state: routerSubject?.getValue().state,
    routePath: routerSubject?.getValue().routePath,
    locale: routerSubject?.getValue().locale,
    breadcrumbs,
    data: pageData,
    i18n,
    prefetchedData,
    appId: currentAppId,
  });

  const { replace } = useNavigate();

  useEffect(() => {
    return routerSubject?.subscribe(async (routerState) => {
      const { pathname, search, state, views } = routerState;
      setTransitionPath((current) => {
        const [, prevTarget] = current;
        return [prevTarget, pathname];
      });
      if (routerState.views.length === 0) {
        setRouteState((routerState) => ({
          ...routerState,
          views: ["404"],
        }));
        return;
      }

      if (state?.shallow) {
        setRouteState((state) => ({
          ...state,
          ...routerState,
        }));
        return;
      }

      const localeSegment = routerState.locale ? `/${routerState.locale}` : "";

      const _pathname =
        localeSegment.length > 0 && pathname === "/" ? "" : pathname;

      const pathnameWithLocaleSegment = `${localeSegment}${_pathname}`;

      const url = `${host}${pathnameWithLocaleSegment}.json${search}`;
      setIsFetching(true);
      let res = { ok: false, json: async () => ({}) } as Response;
      try {
        const result = await Promise.all([
          fetch(url),
          fetchRouteCSS(pathname),
          ...views.map((component) => {
            if (!window?.loaders) return Promise.resolve();
            const loader = window?.loaders?.[component] ?? (() => ({}));
            loader();
          }),
        ]);
        res = result[0];
      } catch (e) {
        console.error(e);
      }

      if (res.ok) {
        const {
          data,
          i18n,
          prefetchedData,
          breadcrumbs,
          meta,
          directive = {},
          is404 = false,
          appId,
        } = await res.json();
        updateMeta(meta);
        if (directive?.kind === "Redirect") {
          if (directive?.path) {
            replace(directive.path, { params: {} } as unknown);
          }

          return;
        }

        if (is404) {
          startTransition(() => {
            setRouteState((state) => ({
              ...state,
              appId,
              views: ["404"],
            }));
          });
        }

        startTransition(() => {
          setRouteState({
            ...routerState,
            appId,
            data,
            i18n,
            prefetchedData,
            breadcrumbs,
          });
        });
      }
      setIsFetching(false);
    });
  }, [routerSubject, fetchRouteCSS, fetch, host, replace]);

  return (
    <RouteTransitionProvider
      isPending={isPending}
      isFetching={isFetching}
      transitionPath={transitionPath}
    >
      <RouteStateProvider state={routeState}>
        <Tree
          action={routeState.action}
          pathname={applyParams(routeState.pathname ?? "/", routeState.params)}
          tree={componentTree}
          entries={routeState.pathname ? routeState.views : ["404"]}
        />
      </RouteStateProvider>
    </RouteTransitionProvider>
  );
};

export const ClientRouter = (props: {
  viewImportMap?: Record<string, ReturnType<typeof lazy>>;
  RootLayout: ComponentType<{ children: ReactNode; locale: string }>;
}) => {
  const { RootLayout } = props;
  const {
    routeManifest,
    router,
    componentTree,
    pageData,
    cssManifest,
    breadcrumbs,
    i18n,
  } = useContext(ServerDataContext);

  return (
    <ThemeProvider>
      <I18nProvider>
        <WebSocketContextProvider>
          <QueryManagerProvider>
            <ComponentsProvider viewImportMap={props.viewImportMap}>
              <ClientRouterProvider
                cssManifest={cssManifest}
                searchParams={router.searchParams}
                params={router.params}
                pageData={pageData}
                is404={router.is404}
                is500={false}
                pathname={router.pathname}
                currentPath={router.currentPath}
                routeManifest={routeManifest}
                breadcrumbs={breadcrumbs}
                urlLocaleSegment={router.urlLocaleSegment}
              >
                <StrictMode>
                  <RootLayout locale={i18n.currentLocale}>
                    <Routes componentTree={componentTree} />
                  </RootLayout>
                </StrictMode>
              </ClientRouterProvider>
            </ComponentsProvider>
          </QueryManagerProvider>
        </WebSocketContextProvider>
      </I18nProvider>
    </ThemeProvider>
  );
};
