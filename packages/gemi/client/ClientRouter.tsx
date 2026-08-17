import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  StrictMode,
  memo,
  useTransition,
  Suspense,
  useSyncExternalStore,
} from "react";

import type { PropsWithChildren, ReactNode, ComponentType, lazy } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { ServerDataContext } from "./ServerDataProvider";
import {
  ClientRouterContext,
  ClientRouterProvider,
} from "./ClientRouterContext";
import type { ComponentTree } from "./types";
import {
  ComponentsContext,
  ComponentsProvider,
  loadViewModule,
  subscribeViewModules,
} from "./ComponentContext";
import {
  QueryManagerContext,
  QueryManagerProvider,
  type QueryConfig,
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

const DefaultQueryErrorFallback = (props: FallbackProps) => {
  return (
    <div role="alert">
      <p>Something went wrong.</p>
      <button type="button" onClick={() => props.resetErrorBoundary()}>
        Try again
      </button>
    </div>
  );
};

const Route = memo((props: PropsWithChildren<RouteProps>) => {
  const { componentPath, pathname, action, children } = props;
  const { viewImportMap, getViewModule } = useContext(ComponentsContext);
  const { clearErrors } = useContext(QueryManagerContext);
  const { data } = useRouteData();

  // `Loading` / `Error` are optional named exports of the view module,
  // subscribed so a Route that rendered before its chunk arrived re-reads
  // the registry once it lands. On the server `getViewModule` reads the
  // eagerly-loaded modules the http server passed in — a streaming render
  // suspends for real, so the `Loading` fallback it puts in the shell must be
  // the same one the client hydrates.
  const getModule = useCallback(
    () => getViewModule?.(componentPath),
    [getViewModule, componentPath],
  );
  const mod = useSyncExternalStore(subscribeViewModules, getModule, getModule);

  const componentData = data?.[pathname]?.[componentPath] ?? {};
  const Component = viewImportMap[componentPath];

  useEffect(() => {
    if (!children) {
      restoreScroll(action, componentPath);
    }
  }, [action, children, componentPath]);

  if (!Component) {
    const NotFound = viewImportMap["404"];
    return <NotFound />;
  }
  const Loading = mod?.Loading;
  const ErrorFallback = mod?.Error ?? DefaultQueryErrorFallback;

  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      resetKeys={[pathname]}
      onReset={clearErrors}
    >
      <Suspense fallback={Loading ? <Loading /> : null}>
        {/* Keyed by view path so swapping views remounts the view (fresh
            state), while the boundary above — keyed by tree slot in `Tree` —
            stays revealed across the swap. */}
        <Component key={componentPath} {...componentData}>
          {props.children}
        </Component>
      </Suspense>
    </ErrorBoundary>
  );
});

export const Tree = memo(
  (props: {
    action: Action;
    tree: ComponentTree;
    entries: string[];
    pathname: string;
  }) => {
    const { entries, tree, pathname, action } = props;

    return (
      <>
        {tree
          .filter(([path]) => entries.includes(path))
          .map((node, slot) => {
            const [path, subtree] = node;
            // Keyed by tree SLOT, not by view path: the Suspense/error
            // boundary inside `Route` must survive a sibling swap (Home →
            // Pricing under the same layout), so React treats it as already
            // revealed and a suspending navigation keeps the previous page on
            // screen. A path key would remount the boundary every navigation,
            // and a brand-new boundary commits its fallback the moment any
            // sibling content (the layout's re-rendered chrome) commits —
            // blanking the outgoing page. The view itself still remounts when
            // the path changes: `Route` keys its Component render.
            if (subtree.length > 0) {
              return (
                <Route
                  action={action}
                  key={`slot-${slot}`}
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
                key={`slot-${slot}`}
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
  const { routerSubject, fetchRouteCSS, preloadRouteModules, takePrefetched } =
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
    features,
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
    features: features ?? {},
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
        // Same reason as the `is404` branch below: the tree about to be mounted
        // carries none of the segments the stale `from` would have the server
        // skip.
        renderedRouteRef.current = "";
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
      // Announced before the imports below start, so each view's own static
      // imports are already in flight rather than discovered one parse at a
      // time once its chunk lands (#352).
      preloadRouteModules(routerState.routePath);
      // Through `loadViewModule` so the module registry — and with it each
      // view's `Loading`/`Error` exports — is populated before the
      // transition commits the new surface.
      for (const component of views) {
        loadViewModule(component);
      }

      const payload = await loadRoutePayload({
        url,
        from,
        takePrefetched,
        renderedRoute: () => renderedRouteRef.current,
        // Query results streaming behind the envelope (#290): hydrating each
        // settles the segment suspended on it — the same wake path streamed
        // documents use.
        onQueryPayload: ([path, variantKey, data]) => {
          hydrate({ [path]: { [variantKey]: data } });
        },
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
          features,
        } = payload;
        updateMeta(meta);
        if (directive?.kind === "Redirect") {
          if (directive?.path) {
            replace(directive.path, { params: {} } as unknown);
          }

          return;
        }

        // Returns, rather than falling through. The commit below spreads
        // `routerState`, which carries the *matched* route's views — so without
        // the return this updater's `["404"]` is queued and then overwritten in
        // the same batch, and the route renders its real views with no data.
        //
        // Reachable only since `.feature()`: a path the client cannot match is
        // caught by the `views.length === 0` guard above and never fetched, so
        // `is404` from the server used to imply an empty client `views`. A gated
        // route keeps its manifest entry, which is exactly the case where the
        // server says 404 and the client still knows how to render the page.
        if (is404) {
          // Not `${pathname}${search}`. `x-gemi-from` tells the server which
          // segments are already mounted so it can skip their handlers, and
          // after this commit the mounted tree is `["404"]` — none of the target
          // route's layouts, and none of the previous route's either. The empty
          // string is what the server reads as "carry nothing".
          renderedRouteRef.current = "";
          startTransition(() => {
            setRouteState((state) => ({
              ...state,
              ...routerState,
              appId,
              i18n,
              features: features ?? state.features,
              // After the spread, deliberately.
              views: ["404"],
            }));
          });
          setIsFetching(false);
          return;
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
            // `?? state.features` rather than a bare assignment: an error-path
            // or older-server envelope carrying no flags must leave the current
            // values on screen, not blank every flag mid-session.
            features: features ?? state.features,
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
  }, [
    routerSubject,
    fetchRouteCSS,
    preloadRouteModules,
    takePrefetched,
    replace,
    hydrate,
  ]);

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
  /** Server only: full view modules for `Loading`/`Error` fallbacks. */
  viewModules?: Record<string, Record<string, any>>;
  RootLayout: ComponentType<{ children: ReactNode; locale: string }>;
  /** App-wide `useQuery` defaults; per-call config always wins. */
  queryConfig?: QueryConfig;
}) => {
  const { RootLayout } = props;
  const {
    routeManifest,
    router,
    componentTree,
    pageData,
    cssManifest,
    modulePreloadManifest,
    breadcrumbs,
    i18n,
  } = useContext(ServerDataContext);

  return (
    <ThemeProvider>
      <I18nProvider>
        <WebSocketContextProvider>
          <QueryManagerProvider queryConfig={props.queryConfig}>
            <ComponentsProvider
              viewImportMap={props.viewImportMap}
              modules={props.viewModules}
            >
              <ClientRouterProvider
                cssManifest={cssManifest}
                modulePreloadManifest={modulePreloadManifest}
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
