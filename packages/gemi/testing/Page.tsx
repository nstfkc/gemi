import {
  Suspense,
  useContext,
  useMemo,
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
  QueryManagerContext,
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
import { ThemeProvider } from "../client/ThemeProvider";
import type { ClientFeatureKey } from "../client/rpc";
import type { Breadcrumb } from "../client/useBreadcrumbs";
import { WebSocketContext } from "../client/WebsocketContext";
import { applyParams } from "../utils/applyParams";
import { Subject } from "../utils/Subject";
import { toVariantKey } from "../utils/variantKey";

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
   * A key may carry a query string (`"/lists?page=2"`) to seed one search
   * variant.
   *
   * The cache is keyed by the *resolved* path, so a key's `:params` are
   * resolved against the page's `params` — and a key naming one the page does
   * not carry is an error, naming the key. That case is common enough to be
   * worth the loud failure: a query often takes its params from the call site
   * rather than the route (`useQuery("/orgs/:orgId/lists", { params: { orgId } })`
   * with `orgId` in component state), and the right seed for it is the resolved
   * path, `"/orgs/abc/lists"`.
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
   * What `useFeature()` reports, keyed by feature key. Anything left out reads
   * as off, exactly as an undeclared key does in a real request.
   *
   * A test seeds the *outcome*, not the declaration: `app/features` owns the
   * targeting and the rollout, and re-deriving those here would mean building a
   * request context — a user, a `session_id`, a bot verdict — to assert a
   * branch that only cares which way the feature came out. Cover the targeting
   * where it lives, with a server test.
   */
  features?: Partial<Record<ClientFeatureKey, boolean>>;
  /**
   * The theme `useTheme()` starts on. The app reads a visitor's stored choice
   * out of `localStorage`; a test has no session to have made one in, so this
   * seeds it without writing to storage. `setTheme` works from either.
   */
  theme?: "light" | "dark" | "system";
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

/**
 * The `:params` a seed key needs supplied. Wildcards (`:rest*`) are excluded —
 * `applyParams` drops those when missing, which is a resolution rather than a
 * failure.
 *
 * Optional params (`:id?`) cannot reach here at all: a key is split at its
 * first `?` to separate the search string, so `"/lists/:folderId?"` arrives as
 * the path `/lists/:folderId`. Seed the resolved path for those.
 */
function requiredParamsOf(path: string): string[] {
  return Array.from(path.matchAll(/:([^/]+)/g), ([, name]) => name).filter(
    (name) => !name.endsWith("*"),
  );
}

/**
 * Fails a `queryData` key whose `:params` the page does not carry, saying so
 * in terms of the key.
 *
 * Without this the two documented runners disagree, and neither is legible.
 * `applyParams` throws `Missing parameter: orgId` under `import.meta.env.DEV`
 * (vitest) — a router-utility stack trace out of `<Page>`'s render, before
 * anything mounts, naming nothing that appears in the test. Under `bun test`
 * that flag is falsy, so it logs and seeds the literal `/orgs/undefined/lists`
 * instead: the seed misses, the query goes to the network, and the assertion
 * runs against a loading state.
 *
 * The case is common because a query's params often come from the call site
 * rather than the route — `useQuery("/orgs/:orgId/lists", { params: { orgId } })`
 * with `orgId` in component state. The cache is keyed by the *resolved* path,
 * so the way out is to seed that path directly.
 */
function resolveSeedPath(
  key: string,
  rawPath: string,
  params: Record<string, string>,
): string {
  const missing = requiredParamsOf(rawPath).filter(
    (name) => params[name] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `[gemi] <Page> cannot resolve the queryData key "${key}": no value for ` +
        `${missing.map((name) => `:${name}`).join(", ")}. The query cache is ` +
        `keyed by the resolved path, so either add ${missing
          .map((name) => `\`${name}\``)
          .join(", ")} to the page's \`params\`, or seed the resolved path ` +
        `(e.g. "${applyParams(
          rawPath,
          Object.fromEntries(missing.map((name) => [name, "123"])),
        )}") — which is what a query taking its params from component state ` +
        `reads under.`,
    );
  }
  return applyParams(rawPath, params);
}

/**
 * `queryData` in the shape the query cache seeds from: `{ [path]: { [variant]:
 * data } }`, the same payload `Query.prefetch` puts on a server-rendered page.
 */
function toPrefetchedData(
  queryData: Record<string, unknown>,
  params: Record<string, string>,
  warned: Set<string>,
) {
  const prefetchedData: Record<string, Record<string, unknown>> = {};
  for (const [key, data] of Object.entries(queryData)) {
    const [rawPath, rawSearch = ""] = key.split("?");
    // Once per key per page, not once per render: this runs again on every
    // re-render, and a duplicated warning reads as a second mistake.
    if (rawPath.startsWith("/api/") && !warned.has(key)) {
      warned.add(key);
      console.warn(
        `[gemi] queryData key "${key}" starts with /api. useQuery is keyed by ` +
          `the path you pass it — the /api prefix is added when it fetches — ` +
          `so this entry seeds a path no query reads.`,
      );
    }
    const path = resolveSeedPath(key, rawPath, params);
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
 * Library's `render`, `react-test-renderer`, or `renderToString`.
 *
 * Two things it does not do.
 *
 * It does not route: there is no view tree and no route manifest behind it, so
 * a navigation is reported through `onNavigate` rather than resolved. To
 * assert the page *after* one, render a second `<Page>`.
 *
 * And under `renderToString` it renders the server's own no-data branch for an
 * *unseeded* query rather than suspending — deliberately, because suspending
 * there is the streaming server's job: `createRoot` threads the request's
 * `ServerQueryStore` through `ServerQueryContext`, and that store is what runs
 * the route handler. A harness has no request and no handler to run, so there
 * is nothing to suspend on. Seeded queries render their data on the server
 * exactly as they do in the browser; unseeded ones behave as a route with no
 * `Query.prefetch` does, framework warning included.
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
    features = {},
    theme,
    fallback = null,
    errorFallback,
    onNavigate,
  } = props;

  // The caller's list, in the caller's order — a language switcher maps over
  // it, so hoisting the page's own locale to the front would reorder the
  // rendered options. The defaults are appended, only to guarantee presence.
  const supportedLocales = useMemo(
    () =>
      Array.from(
        new Set([...(props.supportedLocales ?? []), defaultLocale, locale]),
      ),
    [props.supportedLocales, defaultLocale, locale],
  );
  const pathname = applyParams(routePath, params) || "/";
  const search = toSearchString(searchParams);
  // The URL's locale segment, which the default locale does not get.
  const urlLocaleSegment = locale === defaultLocale ? null : locale;

  const dictionary = useMemo(
    () =>
      toClientDictionary(dictionaries, supportedLocales, locale, translations),
    [dictionaries, supportedLocales, locale, translations],
  );

  // Keys that have already drawn a warning, so a re-render does not repeat it.
  const warnedRef = useRef<Set<string>>(new Set());
  const prefetchedData = useMemo(() => {
    const seeded = toPrefetchedData(queryData, params, warnedRef.current);
    // `useUser` reads `/auth/me` like any other query. Seeding it — with `null`
    // for the anonymous default — is what keeps a component test off the
    // network for a hook nothing in the test asked for.
    seeded["/auth/me"] ??= { "": user ?? null };
    return seeded;
  }, [queryData, params, user]);

  // Keyed by `${view}:${pathname}` in the router's cache; the view names are
  // ours to choose here, and only their order reaches `useBreadcrumbs`.
  const { breadcrumbViews, breadcrumbsCache, breadcrumbsRecord } =
    useMemo(() => {
      const views = breadcrumbs.map((_, index) => `breadcrumb-${index}`);
      const cache = new Map<string, Breadcrumb>(
        breadcrumbs.map((breadcrumb, index) => [
          `${views[index]}:${pathname}`,
          breadcrumb,
        ]),
      );
      return {
        breadcrumbViews: views,
        breadcrumbsCache: cache,
        breadcrumbsRecord: Object.fromEntries(cache),
      };
    }, [breadcrumbs, pathname]);

  const [isNavigatingSubject] = useState(() => new Subject<boolean>(false));
  const [progressManager] = useState(
    () => new ProgressManager(isNavigatingSubject),
  );
  const [history] = useState(() =>
    createMemoryHistory({ initialEntries: [`${pathname}${search}${hash}`] }),
  );

  const routeState: RouteState & PageData = useMemo(
    () => ({
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
      features: features as Record<string, boolean>,
      appId: "test",
    }),
    [
      params,
      search,
      pathname,
      hash,
      routePath,
      urlLocaleSegment,
      locale,
      dictionary,
      supportedLocales,
      prefetchedData,
      breadcrumbsRecord,
      features,
    ],
  );

  const [routerSubject] = useState(() => new Subject<RouteState>(routeState));

  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  // Subscribed during render, not in an effect, because React flushes child
  // effects before parent ones — and mount-time navigation is a real pattern:
  // `<Redirect>` pushes from its own mount effect, as does any auth guard. A
  // listener registered in `<Page>`'s effect is not there yet when those fire,
  // so `onNavigate` would silently miss exactly the redirects a test most
  // wants to assert. Ref-guarded, so React's double-invoke registers one.
  //
  // Nothing unsubscribes: this history is created per `<Page>` and reachable
  // from nowhere else, so it is collected with the page it belongs to.
  const listeningRef = useRef(false);
  if (!listeningRef.current) {
    listeningRef.current = true;
    history.listen(({ location, action }) => {
      const href = `${location.pathname}${location.search}${location.hash}`;
      onNavigateRef.current?.(
        href,
        action === Action.Replace ? "replace" : "push",
      );
    });
  }

  const serverData: ServerDataContextValue = useMemo(
    () => ({
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
      features: features as Record<string, boolean>,
      __csrf: "test-csrf-token",
      cssManifest: {},
      modulePreloadManifest: {},
      meta: {},
      appId: "test",
    }),
    [
      breadcrumbsRecord,
      prefetchedData,
      pathname,
      params,
      routePath,
      search,
      urlLocaleSegment,
      dictionary,
      locale,
      supportedLocales,
      defaultLocale,
      user,
      features,
    ],
  );

  // Everything the router hooks read, inert: nothing here fetches, preloads or
  // resolves a route, but every hook finds the shape it expects rather than an
  // empty context to crash on.
  const [viewEntriesSubject] = useState(() => new Subject<string[]>([]));
  const routerContext = useMemo(
    () => ({
      viewEntriesSubject,
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
    }),
    [
      viewEntriesSubject,
      history,
      breadcrumbViews,
      isNavigatingSubject,
      progressManager,
      breadcrumbsCache,
      routerSubject,
      urlLocaleSegment,
    ],
  );

  const [websocket] = useState(() => ({
    subscribe: async () => {},
    unsubscribe: async () => {},
    broadcast: () => {},
  }));

  return (
    <ThemeProvider theme={theme}>
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
                    <Boundary
                      errorFallback={errorFallback}
                      fallback={fallback}
                      resetKey={pathname}
                    >
                      {children}
                    </Boundary>
                  </RouteStateProvider>
                </RouteTransitionProvider>
              </ClientRouterContext.Provider>
            </QueryManagerProvider>
          </WebSocketContext.Provider>
        </I18nProvider>
      </ServerDataContext.Provider>
    </ThemeProvider>
  );
};

/**
 * The `Suspense` boundary every view renders inside, and — when the test
 * supplies a fallback for it — the error boundary too.
 *
 * `onReset={clearErrors}` is the part that has to be here rather than inline
 * above: it needs `QueryManagerContext`, and it is what makes a view's real
 * `Error` export testable. A fallback whose "Try again" calls
 * `resetErrorBoundary()` re-renders the child, and `useQuery` reads the
 * failure still stored on the `QueryResource` and throws it straight back —
 * so without this the fallback never goes away and the retry path that works
 * in the app cannot be exercised. `ClientRouter`'s own boundary wires exactly
 * this pair.
 */
const Boundary = (
  props: PropsWithChildren<{
    errorFallback?: ComponentType<FallbackProps>;
    fallback: ReactNode;
    resetKey: string;
  }>,
) => {
  const { errorFallback: ErrorFallback, fallback, resetKey, children } = props;
  const { clearErrors } = useContext(QueryManagerContext);
  const content = <Suspense fallback={fallback}>{children}</Suspense>;

  if (!ErrorFallback) {
    return content;
  }

  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      resetKeys={[resetKey]}
      onReset={clearErrors}
    >
      {content}
    </ErrorBoundary>
  );
};
