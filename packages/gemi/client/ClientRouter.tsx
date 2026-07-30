import {
  useContext,
  useEffect,
  useRef,
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
import { I18nProvider } from "./I18nContext";
import { WebSocketContextProvider } from "./WebsocketContext";
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
import { initialRenderedRoute } from "../utils/partialRender";
import { mergeCarriedSegments } from "./helpers/mergeCarriedSegments";
import { routeDataUrl } from "./helpers/routeDataUrl";
import { loadRoutePayload } from "./helpers/loadRoutePayload";

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
  const { routerSubject, fetchRouteCSS, takePrefetched } =
    useContext(ClientRouterContext);
  const { hydrate } = useContext(QueryManagerContext);

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

  // Adopt what the document was rendered with. Without this the initial payload
  // only ever reaches a component that mounts on the first render, and one that
  // mounts on a later navigation — into a route whose layout has since been
  // carried forward rather than re-run — would fetch it over `/api` instead.
  useEffect(() => {
    hydrate(prefetchedData);
  }, [hydrate, prefetchedData]);

  // The route currently on screen, in `x-gemi-from` form. Updated when a
  // response is committed, never when one is merely requested — a navigation
  // that fails must leave the base the server carries segments from intact.
  const renderedRouteRef = useRef(initialRenderedRoute(routeState));

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

      const url = routeDataUrl({ pathname, search, localeSegment });
      const from = renderedRouteRef.current;
      setIsFetching(true);

      // `fetchRouteCSS` keys off the route manifest, so it needs the pattern
      // rather than the concrete path — `/posts/:id`, not `/posts/123`.
      fetchRouteCSS(routerState.routePath).catch((e) => console.error(e));
      for (const component of views) {
        window?.loaders?.[component]?.();
      }

      const payload = await loadRoutePayload({
        url,
        from,
        takePrefetched,
        renderedRoute: () => renderedRouteRef.current,
      });

      if (payload) {
        const {
          data,
          i18n,
          prefetchedData,
          breadcrumbs,
          meta,
          directive = {},
          is404 = false,
          appId,
        } = payload;
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

        const carriedViews: string[] = payload.partial?.carriedViews ?? [];
        renderedRouteRef.current = `${pathname}${search}`;

        // Adopt what the server just prefetched before the new surface mounts
        // and its queries read the cache, otherwise they refetch it over /api.
        // Safe here: this callback is async, so we are past the render phase.
        hydrate(prefetchedData);

        startTransition(() => {
          setRouteState((state) => ({
            ...routerState,
            appId,
            i18n,
            prefetchedData,
            ...mergeCarriedSegments(
              state,
              { pathname, routePath: routerState.routePath, data, breadcrumbs },
              carriedViews,
            ),
          }));
        });
      }
      setIsFetching(false);
    });
  }, [routerSubject, fetchRouteCSS, takePrefetched, replace, hydrate]);

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
