import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Action, createMemoryHistory } from "history";

import type { User } from "../auth/types";
import { ClientRouterContext } from "../client/ClientRouterContext";
import { I18nProvider } from "../client/I18nContext";
import { ProgressManager } from "../client/ProgressManager";
import {
  QueryManagerProvider,
  type QueryConfig,
} from "../client/QueryManagerContext";
import {
  RouteStateProvider,
  type PageData,
  type RouteState,
} from "../client/RouteStateContext";
import { RouteTransitionProvider } from "../client/RouteTransitionProvider";
import {
  ServerDataContext,
  type ServerDataContextValue,
} from "../client/ServerDataProvider";
import type { Breadcrumb } from "../client/useBreadcrumbs";
import { WebSocketContext } from "../client/WebsocketContext";
import { applyParams } from "../utils/applyParams";
import { Subject } from "../utils/Subject";

/**
 * A dictionary as `Dictionary.create` produces it: a name and a
 * `{ key: { locale: string } }` map.
 *
 * Typed structurally rather than as `Dictionary<T>` for two reasons. It keeps
 * `gemi/testing` from importing `gemi/i18n` — a server entry, which reaches the
 * `Lang` facade and through it the container. And it means an object literal of
 * the same shape is accepted, so a test never *has* to import the app's
 * dictionaries at all.
 *
 * Only `name` and `dictionary` are read — both plain data. `Dictionary`'s
 * server-only methods (`render`, `reference`, which throw once `window` is
 * defined) are never called from here.
 */
export interface PageDictionary {
  name: string;
  dictionary: Record<string, Record<string, string>>;
}

export interface PageProps {
  /**
   * The URL the view is mounted at. A template (`/app/:orgId/chat`) is resolved
   * against `params`, so the same string can be pasted from the router.
   */
  pathname?: string;
  /** Route params, as the router would have parsed them out of `pathname`. */
  params?: Record<string, string>;
  /** `"?tab=recent"`, `"tab=recent"`, or `{ tab: "recent" }`. */
  searchParams?: string | Record<string, string | number | boolean>;
  hash?: string;
  /** The locale `useTranslator` and `useLocale` report. */
  locale?: string;
  /**
   * The app's default locale. Links and `useNavigate` omit the locale segment
   * for it, so leaving this equal to `locale` (the default) keeps hrefs
   * unprefixed — set it to seed a page being viewed in a non-default locale.
   */
  defaultLocale?: string;
  supportedLocales?: string[];
  /**
   * Dictionaries the components under test translate against — the app's own,
   * or literals of the same shape.
   *
   * Note what importing the app's costs: `app/i18n/index.ts` imports
   * `gemi/i18n`, a server entry, so the test file pulls the container and
   * `node:async_hooks` into its module graph. Nothing there runs (and nothing
   * here calls it), so it is fine under any runner that has Node builtins —
   * vitest, `bun test` — and not under one that renders in a real browser. Use
   * `translations` there, which is the shape the client actually receives.
   */
  dictionaries?: PageDictionary[];
  /**
   * Translations for the current locale, already resolved: dictionary name →
   * key → string. This is the shape the server serializes onto the page, so it
   * is what the client reads at runtime — and it imports nothing.
   *
   * ```tsx
   * <Page translations={{ Chat: { greeting: "Hello {{name}}" } }}>
   * ```
   *
   * Merged over `dictionaries`, so the two compose: seed from the app's real
   * dictionary and override the one key a test is about.
   */
  translations?: Record<string, Record<string, string>>;
  /**
   * Data `useQuery` finds already cached, keyed by API path — the path passed
   * to `useQuery`, without the `/api` prefix the client adds when it fetches.
   * Keys may carry a query string (`"/lists?page=2"`) to seed one search
   * variant, and may use `:params`, which resolve against `params`.
   *
   * Seeded at mount only: a component that mutates or refetches its data owns
   * the cache from then on.
   */
  queryData?: Record<string, unknown>;
  /** App-wide `useQuery` defaults, as `createRoot` threads them. */
  queryConfig?: QueryConfig;
  /**
   * What `useUser()` reports. Defaults to `null` — an anonymous visitor — and
   * either way the hook resolves from here without issuing a request.
   */
  user?: Partial<User> | null;
  /** What `useBreadcrumbs()` returns, in order. */
  breadcrumbs?: Breadcrumb[];
  /**
   * Fallback for the `Suspense` boundary wrapped around the children — the
   * stand-in for the view's own `Loading` export, which the real router
   * supplies. Defaults to `null`.
   */
  fallback?: ReactNode;
  /**
   * Renders in place of the children when one throws, mirroring a view's
   * `Error` export. Without it a thrown render (an errored suspense query,
   * say) propagates out of `render()` and fails the test, which is usually
   * what you want.
   */
  errorFallback?: ComponentType<FallbackProps>;
  /**
   * Called when something navigates — a `Link` click, `useNavigate().push`.
   * The navigation is reported, not performed: `<Page>` renders one route and
   * does not re-resolve the tree, so `useLocation()` keeps reporting the
   * pathname it was given.
   */
  onNavigate?: (href: string, action: "push" | "replace") => void;
}

/** `"?a=b"` (or `""`) from any of the shapes `searchParams` accepts. */
function toSearchString(search: PageProps["searchParams"]): string {
  if (!search) return "";
  const query =
    typeof search === "string"
      ? search.replace(/^\?/, "")
      : new URLSearchParams(
          Object.entries(search).map(([key, value]) => [key, String(value)]),
        ).toString();
  return query ? `?${query}` : "";
}

/** The cache's variant key: sorted search params, empty when there are none. */
function toVariantKey(search: string): string {
  const searchParams = new URLSearchParams(search);
  searchParams.sort();
  return searchParams.toString();
}

/**
 * `queryData` in the shape the query cache seeds from: `{ [path]: { [variant]:
 * data } }`, the same payload `Query.prefetch` puts on a server-rendered page.
 */
function toPrefetchedData(
  queryData: Record<string, unknown>,
  params: Record<string, string>,
) {
  const prefetchedData: Record<string, Record<string, unknown>> = {};
  for (const [key, data] of Object.entries(queryData)) {
    const [rawPath, rawSearch = ""] = key.split("?");
    if (rawPath.startsWith("/api/")) {
      console.warn(
        `[gemi] queryData key "${key}" starts with /api. useQuery is keyed by ` +
          `the path you pass it — the /api prefix is added when it fetches — ` +
          `so this entry seeds a path no query reads.`,
      );
    }
    const path = applyParams(rawPath, params);
    prefetchedData[path] = {
      ...prefetchedData[path],
      [toVariantKey(rawSearch)]: data,
    };
  }
  return prefetchedData;
}

/**
 * `{ [locale]: { [dictionary]: { [key]: string } } }` — the payload
 * `Translator` serializes onto the page, which is the only form the client
 * ever sees. `dictionaries` are transposed into it (they are keyed the other
 * way round, by key then locale); `translations` is already in it and lands
 * under `locale`, last, so it wins.
 */
function toClientDictionary(
  dictionaries: PageDictionary[],
  locales: string[],
  locale: string,
  translations: Record<string, Record<string, string>>,
): Record<string, Record<string, Record<string, string>>> {
  const clientDictionary: Record<
    string,
    Record<string, Record<string, string>>
  > = {};
  for (const supported of locales) {
    clientDictionary[supported] ??= {};
  }
  for (const { name, dictionary } of dictionaries) {
    for (const [key, byLocale] of Object.entries(dictionary ?? {})) {
      for (const [dictLocale, translation] of Object.entries(byLocale ?? {})) {
        clientDictionary[dictLocale] ??= {};
        clientDictionary[dictLocale][name] ??= {};
        clientDictionary[dictLocale][name][key] = translation;
      }
    }
  }
  for (const [name, keys] of Object.entries(translations)) {
    clientDictionary[locale] ??= {};
    clientDictionary[locale][name] = {
      ...clientDictionary[locale][name],
      ...keys,
    };
  }
  return clientDictionary;
}

/**
 * Mounts a component with the inputs a view normally arrives with — route
 * params, the current locale and its dictionaries, prefetched query data, the
 * signed-in user — so a unit test can assert what it renders rather than only
 * its empty state.
 *
 * ```tsx
 * import { render, screen } from "@testing-library/react";
 * import { Page } from "gemi/testing";
 *
 * render(
 *   <Page
 *     pathname="/app/:orgId/chat"
 *     params={{ orgId: "abc" }}
 *     queryData={{ "/organizations/:orgId/messages": [{ id: 1, body: "hi" }] }}
 *     dictionaries={[ChatDictionary]}
 *   >
 *     <OrgChat />
 *   </Page>,
 * );
 *
 * expect(screen.getByText("hi")).toBeDefined();
 * ```
 *
 * It is a plain component, so it composes with any renderer — Testing
 * Library's `render`, `renderToString`, `react-test-renderer`.
 *
 * What it does not do is route. There is no view tree and no route manifest
 * behind it, so a navigation is reported through `onNavigate` rather than
 * resolved; to assert the page *after* a navigation, render a second `<Page>`.
 */
export const Page = (props: PropsWithChildren<PageProps>) => {
  const {
    children,
    pathname: routePath = "/",
    params = {},
    searchParams,
    hash = "",
    locale = "en-US",
    defaultLocale = locale,
    dictionaries = [],
    translations = {},
    queryData = {},
    queryConfig,
    user = null,
    breadcrumbs = [],
    fallback = null,
    errorFallback,
    onNavigate,
  } = props;

  const supportedLocales = Array.from(
    new Set([defaultLocale, locale, ...(props.supportedLocales ?? [])]),
  );
  const pathname = applyParams(routePath, params) || "/";
  const search = toSearchString(searchParams);
  // The URL's locale segment, which the default locale does not get.
  const urlLocaleSegment = locale === defaultLocale ? null : locale;

  const dictionary = toClientDictionary(
    dictionaries,
    supportedLocales,
    locale,
    translations,
  );
  const prefetchedData = toPrefetchedData(queryData, params);
  // `useUser` reads `/auth/me` like any other query. Seeding it — with `null`
  // for the anonymous default — is what keeps a component test off the network
  // for a hook nothing in the test asked for.
  prefetchedData["/auth/me"] ??= { "": user ?? null };

  // Keyed by `${view}:${pathname}` in the router's cache; the view names are
  // ours to choose here, and only their order reaches `useBreadcrumbs`.
  const breadcrumbViews = breadcrumbs.map((_, index) => `breadcrumb-${index}`);
  const breadcrumbsCache = new Map<string, Breadcrumb>(
    breadcrumbs.map((breadcrumb, index) => [
      `${breadcrumbViews[index]}:${pathname}`,
      breadcrumb,
    ]),
  );
  const breadcrumbsRecord = Object.fromEntries(breadcrumbsCache);

  const [isNavigatingSubject] = useState(() => new Subject<boolean>(false));
  const [progressManager] = useState(
    () => new ProgressManager(isNavigatingSubject),
  );
  const [history] = useState(() =>
    createMemoryHistory({ initialEntries: [`${pathname}${search}${hash}`] }),
  );

  const routeState: RouteState & PageData = {
    views: [],
    params,
    search,
    state: {},
    pathname,
    hash,
    action: null,
    routePath,
    locale: urlLocaleSegment,
    data: {},
    i18n: { currentLocale: locale, dictionary, supportedLocales },
    prefetchedData,
    breadcrumbs: breadcrumbsRecord,
    appId: "test",
  };

  const [routerSubject] = useState(() => new Subject<RouteState>(routeState));

  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  useEffect(() => {
    return history.listen(({ location, action }) => {
      const href = `${location.pathname}${location.search}${location.hash}`;
      onNavigateRef.current?.(
        href,
        action === Action.Replace ? "replace" : "push",
      );
    });
  }, [history]);

  const serverData: ServerDataContextValue = {
    routeManifest: {},
    pageData: {},
    breadcrumbs: breadcrumbsRecord,
    prefetchedData,
    router: {
      pathname,
      params,
      currentPath: routePath,
      is404: false,
      searchParams: search,
      urlLocaleSegment,
    },
    i18n: {
      dictionary,
      currentLocale: locale,
      supportedLocales,
      defaultLocale,
    },
    componentTree: [],
    auth: { user: user as User },
    __csrf: "test-csrf-token",
    cssManifest: {},
    modulePreloadManifest: {},
    meta: {},
    appId: "test",
  };

  // Everything the router hooks read, inert: nothing here fetches, preloads or
  // resolves a route, but every hook finds the shape it expects rather than an
  // empty context to crash on.
  const routerContext = {
    viewEntriesSubject: new Subject<string[]>([]),
    history,
    updatePageData: () => {},
    getPageData: () => ({}),
    getScrollPosition: () => 0,
    getViewPathsFromPathname: () => breadcrumbViews,
    getRoutePathnameFromHref: (href: string) => href,
    isNavigatingSubject,
    setNavigationAbortController: () => {},
    progressManager,
    fetchRouteCSS: async () => {},
    preloadRouteModules: () => {},
    prefetchRoute: async () => {},
    takePrefetched: () => null,
    clearPrefetchCache: () => {},
    breadcrumbsCache,
    routerSubject,
    urlLocaleSegment,
  };

  const websocket = {
    subscribe: async () => {},
    unsubscribe: async () => {},
    broadcast: () => {},
  };

  const ErrorFallback = errorFallback;
  const content = <Suspense fallback={fallback}>{children}</Suspense>;

  return (
    <ServerDataContext.Provider value={serverData}>
      <I18nProvider>
        <WebSocketContext.Provider value={websocket}>
          <QueryManagerProvider queryConfig={queryConfig}>
            <ClientRouterContext.Provider value={routerContext}>
              <RouteTransitionProvider
                isPending={false}
                isFetching={false}
                transitionPath={["", pathname]}
              >
                <RouteStateProvider state={routeState}>
                  {ErrorFallback ? (
                    <ErrorBoundary FallbackComponent={ErrorFallback}>
                      {content}
                    </ErrorBoundary>
                  ) : (
                    content
                  )}
                </RouteStateProvider>
              </RouteTransitionProvider>
            </ClientRouterContext.Provider>
          </QueryManagerProvider>
        </WebSocketContext.Provider>
      </I18nProvider>
    </ServerDataContext.Provider>
  );
};
