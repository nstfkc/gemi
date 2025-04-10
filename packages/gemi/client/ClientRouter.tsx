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
import type { ComponentTree as Tree } from "./types";
import { ComponentsContext, ComponentsProvider } from "./ComponentContext";
import {
  QueryManagerContext,
  QueryManagerProvider,
} from "./QueryManagerContext";
import { I18nContext, I18nProvider } from "./i18n/I18nContext";
import { WebSocketContextProvider } from "./WebsocketContext";
import { HttpClientContext } from "./HttpClientContext";
import { useNavigate } from "./useNavigate";
import { type RouteState, RouteStateProvider } from "./RouteStateContext";

interface RouteProps {
  componentPath: string;
  pathname: string;
}

const Route = memo((props: PropsWithChildren<RouteProps>) => {
  const { componentPath, pathname } = props;
  const { viewImportMap } = useContext(ComponentsContext);

  const { getPageData } = useContext(ClientRouterContext);

  const data = getPageData(componentPath, pathname);

  const Component = viewImportMap[componentPath];

  if (Component) {
    return <Component {...data}>{props.children}</Component>;
  }
  const NotFound = viewImportMap["404"];
  return <NotFound />;
});

const Tree = memo(
  (props: { tree: Tree; entries: string[]; pathname: string }) => {
    const { entries, tree, pathname } = props;
    return (
      <>
        {tree.map((node) => {
          const [path, subtree] = node;
          if (!entries.includes(path)) return null;
          if (subtree.length > 0) {
            return (
              <Route key={path} componentPath={path} pathname={pathname}>
                <Tree tree={subtree} entries={entries} pathname={pathname} />
              </Route>
            );
          }
          return <Route key={path} componentPath={path} pathname={pathname} />;
        })}
      </>
    );
  },
);

const Routes = (props: { componentTree: Tree }) => {
  const { componentTree } = props;
  const [, startTransition] = useTransition();
  const { fetch, host } = useContext(HttpClientContext);

  const { updatePrefecthedData } = useContext(QueryManagerContext);
  const {
    viewEntriesSubject,
    routerSubject,
    updatePageData,
    getRoutePathnameFromHref,
    fetchRouteCSS,
  } = useContext(ClientRouterContext);
  const { fetchTranslations } = useContext(I18nContext);

  const [routeState, setRouteState] = useState<RouteState & { views: string[] }>({
    params: routerSubject.getValue().params,
    search: routerSubject.getValue().search,
    pathname: routerSubject.getValue().pathname,
    views: viewEntriesSubject.getValue(),
  });
  const { replace } = useNavigate();

  useEffect(() => {
    return routerSubject.subscribe(async (router) => {
      const { params, pathname, search, state, views } = router;
      if (state?.shallow) {
        setRouteState(() => ({
          pathname,
          params,
          search,
          views,
        }));
        return;
      }
      const url = `${host}${pathname}.json${search}`;
      const routePathname = getRoutePathnameFromHref(pathname);
      const [res] = await Promise.all([
        fetch(url),
        fetchRouteCSS(routePathname),
        fetchTranslations(routePathname, undefined),
        ...views.map((component) => {
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
            replace(directive.path, { params: {} } as any);
          }

          return;
        }
        updatePageData(data, breadcrumbs);
        updatePrefecthedData(prefetchedData);

        if (is404) {
          startTransition(() => {
            setRouteState((state) => ({
              ...state,
              views: ["404"],
            }));
          });
        }

        startTransition(() => {
          setRouteState({
            pathname,
            params,
            search,
            views,
          });
        });

        // setTimeout(() => {
        //   window.scrollTo(0, getScrollPosition(navigationPath));
        // }, 1);
      }
    });
  }, [viewEntriesSubject]);

  return (
    <RouteStateProvider state={routeState}>
      <Tree pathname={routeState.pathname} tree={componentTree} entries={routeState.views} />
    </RouteStateProvider>
  );
};

export const ClientRouter = (props: {
  viewImportMap?: Record<string, ReturnType<typeof lazy>>;
  RootLayout: ComponentType<{ children: ReactNode }>;
}) => {
  const { RootLayout } = props;
  const {
    routeManifest,
    router,
    componentTree,
    pageData,
    cssManifest,
    breadcrumbs,
    prefetchedData,
  } = useContext(ServerDataContext);

  return (
    <I18nProvider>
      <WebSocketContextProvider>
        <QueryManagerProvider prefetchedData={prefetchedData}>
          <ComponentsProvider viewImportMap={props.viewImportMap}>
            <ClientRouterProvider
              cssManifest={cssManifest}
              searchParams={router.searchParams}
              params={router.params}
              pageData={pageData}
              is404={router.is404}
              pathname={router.pathname}
              currentPath={router.currentPath}
              routeManifest={routeManifest}
              breadcrumbs={breadcrumbs}
            >
              <StrictMode>
                <RootLayout>
                  <Routes componentTree={componentTree} />
                </RootLayout>
              </StrictMode>
            </ClientRouterProvider>
          </ComponentsProvider>
        </QueryManagerProvider>
      </WebSocketContextProvider>
    </I18nProvider>
  );
};
