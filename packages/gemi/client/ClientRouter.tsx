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
import {
  QueryManagerContext,
  QueryManagerProvider,
} from "./QueryManagerContext";
import { I18nContext, I18nProvider } from "./i18n/I18nContext";
import { WebSocketContextProvider } from "./WebsocketContext";
import { HttpClientContext } from "./HttpClientContext";
import { useNavigate } from "./useNavigate";
import { type RouteState, RouteStateProvider } from "./RouteStateContext";
import { applyParams } from "../utils/applyParams";
import { Action } from "history";

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

  const key = [pathname, hash, search].join("");
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
  const { getPageData } = useContext(ClientRouterContext);

  const data = getPageData(componentPath, pathname);

  const Component = viewImportMap[componentPath];

  useEffect(() => {
    if (!children) {
      restoreScroll(action, componentPath);
    }
  }, [action, children, componentPath]);

  if (Component) {
    return <Component {...data}>{props.children}</Component>;
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
  const [, startTransition] = useTransition();
  const { fetch, host } = useContext(HttpClientContext);

  const { updatePrefecthedData } = useContext(QueryManagerContext);
  const { routerSubject, updatePageData, fetchRouteCSS } =
    useContext(ClientRouterContext);
  const { fetchTranslations } = useContext(I18nContext);

  const [routeState, setRouteState] = useState<RouteState>({
    params: routerSubject.getValue().params,
    search: routerSubject.getValue().search,
    pathname: routerSubject.getValue().pathname,
    views: routerSubject.getValue().views,
    action: null,
    hash: routerSubject.getValue().hash,
    state: routerSubject.getValue().state,
    routePath: routerSubject.getValue().routePath,
  });

  const { replace } = useNavigate();

  useEffect(() => {
    return routerSubject.subscribe(async (routerState) => {
      const { pathname, search, state, views } = routerState;
      if (routerState.views.length === 0) {
        setRouteState(() => ({
          ...routerState,
          views: ["404"],
        }));
        return;
      }
      if (state?.shallow) {
        setRouteState(routerState);
        return;
      }

      const url = `${host}${pathname}.json${search}`;
      const [res] = await Promise.all([
        fetch(url),
        fetchRouteCSS(pathname),
        fetchTranslations(pathname, undefined),
        ...views.map((component) => {
          if (!window?.loaders) return Promise.resolve();
          const loader = window?.loaders?.[component] ?? (() => ({}));
          loader();
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
            replace(directive.path, { params: {} } as unknown);
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
          setRouteState(routerState);
        });
      }
    });
  }, [
    routerSubject,
    fetchRouteCSS,
    fetchTranslations,
    fetch,
    host,
    replace,
    updatePageData,
    updatePrefecthedData,
  ]);

  return (
    <RouteStateProvider state={routeState}>
      <Tree
        action={routeState.action}
        pathname={applyParams(routeState.pathname ?? "/", routeState.params)}
        tree={componentTree}
        entries={routeState.pathname ? routeState.views : ["404"]}
      />
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
