import satori from "satori";
// @ts-ignore
import sharp from "sharp";

import { HttpRequest } from "../../http";
import { GEMI_REQUEST_BREAKER_ERROR } from "../../http/Error";
import { RequestContext } from "../../http/requestContext";
import type { RouterMiddleware } from "../../http/Router";
import {
  createFlatViewRoutes,
  type FlatViewRoutes,
  type ViewRouteExec,
} from "./createFlatViewRoutes";
import { viewRouteConfigDefaults, type ViewRouteConfig } from "./config";
import { resolvePartialRender } from "./planPartialRender";
import { matchViewRoute } from "./matchViewRoute";
import { PARTIAL_RENDER_HEADER, type PartialRenderInfo } from "../../utils/partialRender";
import { createElement, Fragment } from "react";

import { createFileResponse, type FileOutput, type ViewRoutes } from "../../http/ViewRouter";
import { createRouteManifest } from "./createRouteManifest";
import { createComponentTree } from "./createComponentTree";
import { flattenComponentTree } from "../../client/helpers/flattenComponentTree";
import type { ComponentTree } from "../../client/types";
import { Translator } from "../../i18n/Translator";
import { MiddlewareRegistry } from "../middleware/MiddlewareRegistry";
import { Log } from "../../facades/Log";
import { Lang } from "../../facades/Lang";
import { AuthViewRouter } from "../../auth/routes";
import { KernelId } from "../kernel-id/KernelId";
import { app } from "../../foundation/app";
import { kernelContext } from "../../kernel/context";
import { ServerQueryStore, type StreamSummary } from "./ServerQueryStore";
import { createServerQueryFetcher } from "./serverQueryFetcher";
import { injectQueryPayloads, isBotUserAgent } from "./streamQueryInjection";
import { createShellContentObserver, createShellContentReporter } from "./shellContentReport";
import { createRoutePayloadStream } from "./routePayloadStream";

/**
 * React's server renderer, loaded on the first render rather than on import.
 *
 * **Importing `react-dom/server.browser` keeps the process alive forever.** On
 * React 19.2.3 under Bun, that one import — nothing else, no render, no server
 * — is enough that the process never exits: `getActiveResourcesInfo()` comes
 * back empty, there are no timers, no sockets and an empty kqueue, and it hangs
 * anyway. `react-dom/server.node` does not do it. Reduced from #316's third
 * item, which reports the same hang from `await import("gemi/kernel")` and
 * predates the 0.51 line.
 *
 * That import sat at module scope here, and this module is reachable from
 * `gemi/kernel` through `RouteServiceProvider` — so *any* script that touched
 * the kernel inherited the hang and needed an explicit `process.exit()`. A
 * one-off migration, a seeder, a cron entry point, a CI check: all of them
 * loaded the SSR renderer to get a `Kernel` they were going to use for
 * something else entirely.
 *
 * Deferring it costs one already-resolved dynamic import on the first document
 * render and nothing after — `react-dom` is external in the framework build, so
 * this stays a runtime resolve out of the app's own `node_modules` exactly as
 * the static import was. A server renders, so it pays this once at first
 * request; a script that never renders no longer pays it at all, which is the
 * whole point.
 *
 * Wrapped rather than awaited at each call site so the three of them read
 * unchanged.
 *
 * The slot is cleared on failure so a rejection is not what gets memoised. A
 * missing `react-dom` is fatal either way — this is about the diagnostic, not
 * about recovery: caching the rejected promise would make every later render
 * report whatever the loader threw the first time, with no stack from the call
 * that actually failed.
 */
let serverRenderer:
  | Promise<{ renderToReadableStream: (...args: any[]) => Promise<any> }>
  | undefined;

const renderToReadableStream = async (...args: any[]): Promise<any> => {
  // @ts-ignore
  serverRenderer ??= import("react-dom/server.browser").catch((error) => {
    serverRenderer = undefined;
    throw error;
  });
  return (await serverRenderer).renderToReadableStream(...args);
};

/**
 * How long a document response may keep streaming before pending segments are
 * cut over to client rendering. One hung query must not hold the connection
 * open forever; the browser resolves whatever was aborted over `/api`.
 */
const STREAM_DEADLINE_MS = 10_000;

const themeScript = `
!function(){try{var d=document.documentElement,c=d.classList;
c.remove('light','dark');
var e=localStorage.getItem('theme');
if('system'===e||(!e&&'system'===defaultTheme)){
  var t='(prefers-color-scheme: dark)',m=window.matchMedia(t);
  if(m.media!==t||m.matches){d.style.colorScheme='dark';c.add('dark')}
  else{d.style.colorScheme='light';c.add('light')}
}else if(e){
  c.add(e||'')
}}catch(e){}}()
`;

async function getTtfFont(
  family: string,
  weight: number,
  style: "normal" | "italic",
): Promise<ArrayBuffer> {
  const familyParam = `${style === "italic" ? "italic," : ""}wght@${style === "italic" ? "1," : ""}${weight}`;

  // Get css style sheet with user agent Mozilla/5.0 Firefox/1.0 to ensure non-variable TTF is returned
  const cssCall = await fetch(
    `https://fonts.googleapis.com/css2?family=${family}:${familyParam}&display=swap`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 Firefox/1.0",
      },
    },
  );

  const css = await cssCall.text();
  const ttfUrl = css.match(/url\(([^)]+)\)/)?.[1];

  return await fetch(ttfUrl).then((res) => res.arrayBuffer());
}

/**
 * `/assets` is where the client build output is served from, ahead of the
 * router — a route mounted there could never be reached in production, and in
 * dev it would appear to work. Fail at boot instead of shipping that.
 */
export const RESERVED_ROUTE_PREFIX = "/assets";

export function assertNoReservedRoutePaths(routePaths: string[]) {
  const reserved = routePaths.filter(
    (path) => path === RESERVED_ROUTE_PREFIX || path.startsWith(`${RESERVED_ROUTE_PREFIX}/`),
  );

  if (reserved.length > 0) {
    const many = reserved.length > 1;
    throw new Error(
      `View route path${many ? "s" : ""} ${reserved.map((path) => `"${path}"`).join(", ")} ` +
        `use${many ? "" : "s"} the reserved "${RESERVED_ROUTE_PREFIX}" prefix. ` +
        `The client build output is served from there before the router runs, so the route would never match. ` +
        `Mount it somewhere else.`,
    );
  }
}

export class ViewRouteDispatcher {
  static token = "router.view";

  flatViewRoutes: FlatViewRoutes = {};
  routeManifest: Record<string, string[]> = {};
  /** `routeManifest` without file routes — they have no component to render client side. */
  clientRouteManifest: Record<string, string[]> = {};
  componentTree: ComponentTree = [];
  flatComponentTree: string[] = [];
  root: any = null;
  /**
   * The shell-content hint (#294): React defers any boundary over
   * `progressiveChunkSize` on size alone, so a page that reads fine without
   * JS can go blank the day one more section pushes it over the budget — and
   * nothing else notices the transition (#289 was found by hand-measuring).
   * The reporter owns the once-per-route-per-boot dedup so a hot route
   * doesn't spam the dev console.
   */
  private shellReporter = createShellContentReporter();

  /**
   * `modulepreload` elements per route, built once instead of per request —
   * everything they derive from (the built chunk graph, the client entry) is
   * fixed at boot, and React elements are immutable, so one set is reusable
   * across every render of that route.
   *
   * Keyed on the manifest object rather than a plain field so a process that
   * ever renders against two of them — a test suite, most obviously — can
   * never serve one route's chunks out of the other's cache.
   */
  private preloadCache = new WeakMap<
    object,
    { clientEntry: unknown; byRoute: Map<string, any[]> }
  >();

  private readonly hooks: Required<
    Pick<
      ViewRouteConfig,
      "onRequestStart" | "onRequestEnd" | "onRequestFail" | "onStreamComplete"
    >
  >;

  /** See `ViewRouteConfig.partialRendering`. */
  readonly partialRendering: boolean;

  constructor(config: ViewRouteConfig) {
    const defaults = viewRouteConfigDefaults();

    this.partialRendering = config.partialRendering ?? defaults.partialRendering;

    this.hooks = {
      onRequestStart: config.onRequestStart ?? defaults.onRequestStart,
      onRequestEnd: config.onRequestEnd ?? defaults.onRequestEnd,
      onRequestFail: config.onRequestFail ?? defaults.onRequestFail,
      onStreamComplete: config.onStreamComplete ?? defaults.onStreamComplete,
    };

    const routes: ViewRoutes = {
      "/": config.rootRouter,
      "/auth": AuthViewRouter,
    };
    this.flatViewRoutes = createFlatViewRoutes(routes);
    assertNoReservedRoutePaths(Object.keys(this.flatViewRoutes));
    this.routeManifest = createRouteManifest(routes);
    this.clientRouteManifest = Object.fromEntries(
      Object.entries(this.routeManifest).filter(([, views]) => views.at(-1) !== "FILE"),
    );
    this.componentTree = createComponentTree(routes);
    this.flatComponentTree = flattenComponentTree(this.componentTree);
    this.root = config.root;
  }

  async onRequestEnd(req: HttpRequest) {
    if (!req.cookies.has("session_id")) {
      req.ctx().setCookie("session_id", Bun.randomUUIDv7(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Strict",
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
    }

    return await this.hooks.onRequestEnd(req);
  }

  /**
   * Fires the provider's `onStreamComplete` from a stream callback — an
   * observability hook must never break the response body it observes, so
   * sync throws and rejections are logged and swallowed.
   *
   * Call sites must invoke this inside the request scope (see
   * `runInRequestScope` in `handleViewRequest`): stream callbacks are driven
   * by the HTTP server after the handler returned, outside the kernel
   * AsyncLocalStorage — where both the user's hook and this very `Log.error`
   * guard would break.
   */
  private completeStream(req: HttpRequest, summary: StreamSummary) {
    const logError = (err: any) => {
      Log.error(err?.message ?? 'Error in "onStreamComplete" event handler', {
        err: JSON.stringify(err),
      });
    };
    try {
      Promise.resolve(this.hooks.onStreamComplete(req, summary)).catch(logError);
    } catch (err) {
      logError(err);
    }
  }

  /** See `preloadCache`. */
  private modulePreloadLinks(args: {
    clientEntry?: { module: string; preload: string[] };
    modulePreloadManifest?: Record<string, string[]>;
    views: string[];
    routeKey: string;
  }) {
    const { clientEntry, modulePreloadManifest, views, routeKey } = args;

    const build = () => {
      const hrefs = new Set<string>(clientEntry?.preload ?? []);
      for (const view of views) {
        for (const href of modulePreloadManifest?.[view] ?? []) {
          hrefs.add(href);
        }
      }
      return [...hrefs].map((href) =>
        createElement("link", {
          key: `modulepreload:${href}`,
          rel: "modulepreload",
          href,
        }),
      );
    };

    // Dev: no chunk graph to announce, so there is nothing worth caching.
    if (!modulePreloadManifest) {
      return build();
    }

    let cached = this.preloadCache.get(modulePreloadManifest);
    if (!cached || cached.clientEntry !== clientEntry) {
      cached = { clientEntry, byRoute: new Map() };
      this.preloadCache.set(modulePreloadManifest, cached);
    }
    let links = cached.byRoute.get(routeKey);
    if (!links) {
      links = build();
      cached.byRoute.set(routeKey, links);
    }
    return links;
  }

  private async render(props: {
    req: HttpRequest;
    /**
     * Re-enters the kernel + request AsyncLocalStorage scopes captured while
     * the request was live. Every stream lifecycle callback below runs after
     * the handler returned — driven by the HTTP server, outside both scopes —
     * so user hooks are always invoked through this.
     */
    runInRequestScope: <T>(fn: () => T) => T;
    viewData: any;
    pathname: string;
    currentPathName: string;
    csrfTokenHMAC: Buffer;
    headers: any;
    url: URL;
    i18n: any;
    user: any;
    serverQueries: ServerQueryStore;
    userAgent: string | null;
    noStream: boolean;
    params: any;
    breadcrumbs: any;
    urlLocaleSegment?: string;
    meta: any;
    isOgRequest?: boolean;
    appId: string;
  }) {
    const {
      req,
      runInRequestScope,
      csrfTokenHMAC,
      currentPathName,
      headers,
      i18n,
      params,
      pathname,
      serverQueries,
      userAgent,
      noStream,
      url,
      user,
      viewData,
      breadcrumbs,
      urlLocaleSegment,
      meta,
      isOgRequest,
      appId,
    } = props;

    const pageDataKey = pathname.replace(`/${urlLocaleSegment}`, "");

    const result = {
      kind: "view",
      data: {
        meta,
        pageData: {
          [pageDataKey]: viewData,
        },
        __csrf: csrfTokenHMAC.toString("base64"),
        // Placeholder — re-snapshotted at render time (below) so everything
        // that resolved while styles and modules loaded still makes the
        // document payload instead of streaming.
        prefetchedData: {} as Record<string, Record<string, any>>,
        i18n,
        auth: { user },
        routeManifest: this.clientRouteManifest,
        breadcrumbs,
        router: {
          urlLocaleSegment,
          pathname: currentPathName,
          params,
          currentPath: pathname,
          searchParams: url.search,
          is404: !currentPathName ? true : false,
        },
        appId,
        componentTree: [["404", []], ...this.componentTree],
      },
      head: {},
    };

    const Root = this.root;
    const currentViews = this.routeManifest[currentPathName];
    return async (params: {
      getStyles: (p: string[]) => Promise<any[]>;
      viewImportMap: any;
      bootstrapModules?: string[];
      loaders: string;
      cssManifest: Record<string, string[]>;
      ogMap: Record<string, any>;
      /**
       * Full view modules (not just default exports) so `Route` can render a
       * view's `Loading`/`Error` exports on the server — a streamed shell
       * carries real fallbacks, and they must match what the client hydrates.
       */
      viewModules?: Record<string, any>;
      /**
       * The client entry, when the server wants it booted from the bootstrap
       * script instead of handed to React as a `bootstrapModule`: `module` is
       * imported, `preload` is every chunk that import pulls in.
       *
       * React preloads its own `bootstrapModules` with `fetchPriority="low"`
       * hardcoded (Fizz has no option for it), which parks the one module
       * that unblocks hydration behind everything else the page is fetching.
       * Emitting the `modulepreload` ourselves gets it the browser's default
       * script priority, and it is the same request either way — the
       * `import()` below consumes the preloaded module (#352).
       */
      clientEntry?: { module: string; preload: string[] };
      /**
       * Built chunk URLs per view name, like `cssManifest`. Only the current
       * route's chain is preloaded.
       */
      modulePreloadManifest?: Record<string, string[]>;
    }) => {
      const {
        bootstrapModules = [],
        loaders,
        getStyles,
        viewImportMap,
        cssManifest,
        ogMap,
        viewModules,
        clientEntry,
        modulePreloadManifest,
      } = params;

      // `clientEntry` and `bootstrapModules` are two spellings of the same job,
      // and running both would boot the entry twice — once through React's
      // `<script type="module">`, once through the `import()` below. The entry
      // wins where it is offered, so React is handed nothing and never emits
      // the `fetchPriority="low"` preload that made it worth taking over.
      const reactBootstrapModules = clientEntry ? [] : bootstrapModules;

      const bootstrapScriptContent = (data: string) =>
        [
          data,
          `window.loaders=${loaders}`,
          // Nothing imports the entry when the server routed it through
          // `clientEntry` — the bootstrap script is where it starts. The
          // `.catch` re-throws out of the microtask because a bare `import()`
          // here would report a chunk that 404s after a deploy, or an entry
          // that throws while evaluating, as an `unhandledrejection` only —
          // which `window.onerror`-based reporters do not see. The page would
          // then sit permanently unhydrated with nothing raised.
          ...(clientEntry
            ? [
                `import(${JSON.stringify(clientEntry.module)}).catch(function(e){setTimeout(function(){throw e})})`,
              ]
            : []),
        ].join(";");

      if (isOgRequest) {
        let ogHandler = null;
        let ogComponent = null;
        // `currentViews` is `undefined` on an unmatched route. Without the
        // guard `GET /nope.og` throws here and `httpProd` answers with the raw
        // stack trace, where the 404 below is what a crawler should get.
        for (const view of currentViews ?? []) {
          if (typeof ogMap[view] === "function") {
            ogComponent = view;
            ogHandler = ogMap[view];
          }
        }
        if (!ogHandler) {
          return new Response("Not found", { status: 404 });
        }
        const data = Object.values(result.data.pageData)[0];

        try {
          await renderToReadableStream(createElement(ogHandler, data[ogComponent]), {
            onError: () => {},
          });
        } catch (err) {
          const { fonts, ...options } = err.satoriOptions;
          const _fonts = await Promise.all(
            fonts.map((font) => {
              return getTtfFont(font.name, font.weight, font.style).then((data) => ({
                ...font,
                data,
              }));
            }),
          );

          const ogHeaders = new Headers(headers);
          ogHeaders.set("Content-Type", "image/png");
          const svg = await satori(err.jsx, { ...options, fonts: _fonts });
          const png = await sharp(Buffer.from(svg))
            .png({
              compressionLevel: 0,
              effort: 10,
            })
            .toBuffer();

          return new Response(new Uint8Array(png), { headers: ogHeaders });
        }

        return new Response("data");
      }

      result.data["cssManifest"] = cssManifest;
      // Hydration reaches each route segment through `window.loaders`, i.e. an
      // `import()` the browser cannot see until the entry has run — and it
      // sees a nested chunk only once its parent has parsed. On a real
      // network that serial chain shows every boundary's `Loading` fallback
      // where server-rendered content already is, collapsing the page height
      // and restoring it a round trip later (#352). Preloaded in the shell
      // head, the whole chain is fetched in parallel with the entry and is
      // resident before hydration asks for it.
      //
      // An unmatched route leaves `currentViews` undefined but still renders a
      // document — the `404` view, the one route class most likely to be hit
      // cold — so it preloads that view's chain, mirroring the `["404"]` the
      // client mounts.
      const preloadLinks = this.modulePreloadLinks({
        clientEntry,
        modulePreloadManifest,
        views: currentViews ?? ["404"],
        routeKey: currentPathName ?? "404",
      });

      const styles = await getStyles(currentViews);

      // Everything resolved by now ships in the document payload; everything
      // still in flight streams in behind it. The snapshot marks its entries
      // as shipped so the injector doesn't send them twice.
      result.data.prefetchedData = serverQueries.snapshotResolved();
      serverQueries.markRenderStart();

      const deadline = new AbortController();
      const deadlineTimer = setTimeout(() => deadline.abort(), STREAM_DEADLINE_MS);

      // Decided before the render call because it changes *render-time*
      // behavior: React splits any boundary bigger than
      // `progressiveChunkSize` (~12.8KB) out of the shell as it renders, and
      // awaiting `allReady` afterwards settles the data but cannot undo the
      // split — a non-JS reader would see a body whose content is parked in
      // `<div hidden>` + `$RC()` reveal scripts (#286, #289). Two audiences
      // need the settled document: crawlers (detected by UA — progressive
      // chunking only exists to reach a browser sooner, which is worthless to
      // a client that buffers the whole response) and routes that declared
      // `"no-stream"` (marketing/content pages that must render for
      // JS-disabled humans, text browsers, and failed-script loads too).
      const settled = isBotUserAgent(userAgent) || noStream;

      // Dev-only: collect the streamed bytes so the close hook can measure
      // what a no-JS reader gets (#294). A settled document carries its
      // content inline by construction — nothing to measure — and a route
      // already hinted this boot skips the collection entirely.
      const shellObserver =
        process.env.NODE_ENV !== "production" &&
        !settled &&
        currentPathName &&
        this.shellReporter.shouldObserve(currentPathName)
          ? createShellContentObserver()
          : null;

      try {
        const stream = await renderToReadableStream(
          createElement(Fragment, {
            children: [
              // React hoists these into `<head>`, ahead of the inlined
              // stylesheets, so the browser starts the fetches on the shell's
              // first bytes.
              ...preloadLinks,
              ...styles,
              createElement("script", {
                key: "theme-script",
                dangerouslySetInnerHTML: {
                  __html: themeScript,
                },
              }),
              createElement(Root, {
                data: result.data,
                viewImportMap,
                viewModules,
                serverQueries,
                key: "root",
              }),
            ],
          }),
          {
            bootstrapScriptContent: bootstrapScriptContent(
              `window.__GEMI_DATA__ = ${JSON.stringify(result.data)}`,
            ),
            bootstrapModules: reactBootstrapModules,
            signal: deadline.signal,
            ...(settled ? { progressiveChunkSize: Number.MAX_SAFE_INTEGER } : {}),
            // A query rejecting inside a streamed segment is expected: React
            // client-renders that boundary and the browser surfaces the error
            // through its own fetch. Log it and move on.
            onError(error: unknown) {
              if (process.env.NODE_ENV !== "production") {
                console.error(error);
              }
            },
          },
        );

        stream.allReady
          .catch(() => {})
          .finally(() => clearTimeout(deadlineTimer));

        // A settled response waits for everything before the first byte.
        // Works only together with the `progressiveChunkSize` override
        // above: this waits for the data, that keeps the content inline
        // instead of script-revealed.
        if (settled) {
          await stream.allReady.catch(() => {});
        }

        return new Response(
          injectQueryPayloads(stream, serverQueries, {
            // A settled body has no shell-then-stream phase — its first byte
            // already carries everything — so only progressive responses mark
            // one; the summary then reports `shellAt === settledAt` for the
            // settled ones.
            onShell: settled ? undefined : () => serverQueries.markShell(),
            onChunk: shellObserver?.onChunk,
            // The APM-visible end of the request: the body closed, not the
            // handler returned (that was at time-to-shell).
            onClose: () =>
              runInRequestScope(() => {
                this.completeStream(req, serverQueries.summarize(deadline.signal.aborted));
                if (shellObserver) {
                  // The injector's `onChunk` collected the exact bytes the
                  // visitor got; measured once the body closed (#294).
                  this.shellReporter.report(currentPathName, shellObserver.measure());
                }
              }),
          }),
          {
            status: !currentPathName ? 404 : 200,
            headers,
          },
        );
      } catch (err) {
        clearTimeout(deadlineTimer);
        const stream = await renderToReadableStream(createElement("div"), {
          bootstrapScriptContent: bootstrapScriptContent(
            `window.error= ${JSON.stringify(err.message)}; window.stack_trace=${JSON.stringify(err.stack)};window.__GEMI_DATA__ = ${JSON.stringify(result.data)}`,
          ),
          bootstrapModules:
            process.env.NODE_ENV === "development"
              ? ["/render-error.js", ...reactBootstrapModules]
              : reactBootstrapModules,
        });
        // The failed-render body still closes, and the span-ending hook is
        // pinned to the body closing, not the render succeeding — a span that
        // only ends on happy paths leaks for exactly the requests worth
        // seeing. No shell mark: this body is one settled error document.
        return new Response(
          injectQueryPayloads(stream, serverQueries, {
            onClose: () =>
              runInRequestScope(() =>
                this.completeStream(req, serverQueries.summarize(deadline.signal.aborted)),
              ),
          }),
          {
            status: !currentPathName ? 404 : 200,
            headers,
          },
        );
      }
    };
  }

  async handleViewRequest(req: Request) {
    const url = new URL(req.url);
    const isViewDataRequest = url.pathname.endsWith(".json");
    const isOgRequest = url.pathname.endsWith(".og");
    const urlPathnameWithLocale = url.pathname.replace(".json", "").replace(".og", "");

    const [, maybeLocale, ...rest] = urlPathnameWithLocale.split("/");
    let urlPathname = `/${rest.join("/")}`;
    let urlLocaleSegment = null;
    let urlLocale: string | null = null;

    const translator = app(Translator);

    const isPathnameWithLocale =
      !translator.supportedLocales.includes(maybeLocale);

    if (isPathnameWithLocale) {
      urlPathname = urlPathnameWithLocale;
    } else {
      urlLocaleSegment = maybeLocale;
      urlLocale = maybeLocale;
    }

    if (translator.isEnabled && !isOgRequest) {
      const locale = app(Translator).detectLocale(
        new HttpRequest(req, {}, "view", urlPathname),
      );

      if (urlLocale === null && locale !== translator.defaultLocale) {
        const _pathname = url.pathname === "/" ? "" : url.pathname;
        return new Response("", {
          status: 302,
          headers: {
            "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
            Location: `/${locale}${_pathname}${url.search}`,
          },
        });
      }
    }

    urlPathname = urlPathname.replace("//", "/");
    let handlers: ViewRouteExec[] = [];
    let middlewares: (RouterMiddleware | string)[] = [];
    let currentPathName: null | string = null;
    let params: Record<string, any> = {};
    let partial: PartialRenderInfo | null = null;
    // `"no-stream"` in a route's (or its router's) middleware list opts the
    // route out of progressive streaming: everyone gets the fully settled
    // document a bot UA would (#289). It is a directive read here, not real
    // middleware — the middleware runner ignores unknown aliases.
    let noStream = false;

    try {
      const match = matchViewRoute(this.flatViewRoutes, urlPathname);
      if (match) {
        currentPathName = match.routePath;
        params = match.params;
        handlers = match.route.exec;
        middlewares = match.route.middleware;
        noStream = middlewares.includes("no-stream");

        // Only navigations skip work. A document request renders the whole
        // tree, and the client has nothing to carry forward yet.
        if (isViewDataRequest && this.partialRendering) {
          const from = req.headers.get(PARTIAL_RENDER_HEADER);
          const plan = resolvePartialRender({
            flatViewRoutes: this.flatViewRoutes,
            supportedLocales: app(Translator).supportedLocales,
            from,
            origin: url.origin,
            to: { segments: match.route.segments, params, search: url.search },
          });

          if (plan.startIndex > 0) {
            handlers = handlers.slice(plan.startIndex);
            partial = { from, carriedViews: plan.carriedViews };
          }
        }
      }
    } catch (err) {
      // TODO: Handle this
      throw err;
    }

    const httpRequest = new HttpRequest(req, params, "view", currentPathName);
    this.hooks.onRequestStart(httpRequest);
    return await RequestContext.run(httpRequest, async () => {
      let pageData: {
        cookies: Set<string>;
        headers: Headers;
        currentPathName: string;
        data: Record<string, any>;
        prefetchedData: Record<string, any>;
        user: any; // TODO: fix type
        params: Record<string, any>;
        urlLocaleSegment: string | null;
        meta: any;
        appId: string;
      } | null = null;
      const ctx = RequestContext.getStore();
      // The HTTP server drives the response body — and therefore every stream
      // lifecycle callback — after `app.fetch` returned, outside the kernel
      // AsyncLocalStorage scope and outside this request's context (the same
      // phenomenon `createServerQueryFetcher` documents for render-discovered
      // fetches). Facades and `req.ctx()` inside `onStreamComplete` /
      // `onRequestFail` would break there, so capture both scopes while they
      // are live and re-enter them around every hook invocation below.
      const kernelStore = kernelContext.getStore();
      const runInRequestScope = <T>(fn: () => T): T =>
        kernelContext.run(kernelStore, () => RequestContext.runWith(ctx, fn));
      // Before middleware and handlers, so every `Query.prefetch` along the
      // way lands in one live, request-scoped store.
      ctx.serverQueries = new ServerQueryStore(createServerQueryFetcher(req));
      // A query rejecting during the streamed render (or a fire-and-forget
      // prefetch) never throws the handler, so the catch below can't see it —
      // error tracking wired to `onRequestFail` would miss server-side work
      // that failed. Route rejections through the hook here. The identity set
      // keeps `Query.instant` rethrows — which DO reach the catch — from
      // reporting the same error twice.
      const reportedQueryErrors = new Set<any>();
      ctx.serverQueries.onQueryFail((entry) => {
        reportedQueryErrors.add(entry.error);
        try {
          // In scope, and with the rejection handler attached *inside* the
          // scope, so a facade-using hook works for render-phase failures
          // exactly as it does for handler-phase ones.
          runInRequestScope(() =>
            Promise.resolve(this.hooks.onRequestFail(httpRequest, entry.error)).catch(
              () => {},
            ),
          );
        } catch {
          // An error-reporting hook must not break the settle chain it
          // observes — a suspended segment is waiting on it.
        }
      });

      if (urlLocale) {
        const locale = urlLocale.replaceAll("/", "");
        Lang.setLocale(locale);
      } else {
        Lang.setLocale();
      }

      const httpRequest = ctx.req;

      try {
        await app(MiddlewareRegistry).runMiddleware(middlewares);

        const translator = app(Translator);
        const isI18nEnabled = translator.isEnabled;
        let i18n: Record<string, any> = {};
        if (isI18nEnabled) {
          let locale = null;
          if (urlLocale) {
            locale = urlLocale.replaceAll("/", "");
            ctx.setLocale(locale);
          } else {
            locale = translator.detectLocale(
              new HttpRequest(req, httpRequest.params as any),
            );
            ctx.setLocale(locale);
          }

          const translations = translator.getPageTranslations(
            locale,
            httpRequest.routePath,
          );

          i18n = {
            supportedLocales: translator.supportedLocales,
            currentLocale: locale,
            dictionary: {
              [locale]: translations,
            },
            defaultLocale: translator.defaultLocale,
          };
        }

        // Handlers gate the response — they decide redirects, status codes,
        // cookies — so they are awaited. Queries do not: `Query.prefetch`
        // starts its request the moment it is called (a live store, so a
        // prefetch after a handler's first `await` is no longer silently
        // dropped), and both response shapes stream whatever is still in
        // flight — the document as interleaved payload scripts, the `.json`
        // navigation payload as NDJSON lines (#290).
        const data = await Promise.all(handlers.map((fn) => fn(httpRequest as any)));

        const cookies = ctx.cookies;
        const headers = ctx.headers;

        pageData = {
          data,
          cookies,
          headers,
          user: ctx.user,
          prefetchedData: ctx.serverQueries.snapshotResolved(),
          currentPathName: httpRequest.routePath,
          params: httpRequest.params,
          urlLocaleSegment,
          meta: ctx.renderMeta(),
          appId: app(KernelId).id,
        };

        const { params, currentPathName, user } = pageData;

        const viewData = {};
        const breadcrumbs = {};
        for (const part of data ?? []) {
          const [key, value] = Object.entries(part)?.[0] ?? [];
          if (!key || !value) {
            continue;
          }
          breadcrumbs[`${key}:${currentPathName}`] = (value as any).breadcrumb;
          viewData[key] = value;
        }

        const fileOutput: FileOutput | undefined = (viewData as any).FILE;
        if (fileOutput) {
          for (const cookie of cookies) {
            headers.append("Set-Cookie", cookie.toString());
          }

          try {
            await this.onRequestEnd(httpRequest);
          } catch (err) {
            Log.error(err?.message ?? 'Error in "onRequestEnd" event handler', {
              err: JSON.stringify(err),
            });
          }

          return await createFileResponse(fileOutput, headers);
        }

        if (isViewDataRequest) {
          // NDJSON: envelope first — sent at handler speed — then one line
          // per query as it settles (#290). The client commits the
          // navigation off the envelope and hydrates the rest as it lands.
          headers.set("Content-Type", "application/x-ndjson; charset=utf-8");
          // The body depends on the route the client came from, so no shared
          // cache may serve one client's partial response to another.
          headers.append("Vary", PARTIAL_RENDER_HEADER);

          cookies.forEach((cookie) => headers.append("Set-Cookie", cookie.toString()));

          await this.hooks.onRequestEnd(httpRequest);

          const envelope = {
            // Nothing that rendered touched the metadata, so the segments
            // that were skipped are still the ones that own it.
            meta: partial && !ctx.metadata.touched ? null : pageData.meta,
            data: {
              [urlPathname]: viewData,
            },
            breadcrumbs,
            // Resolved-so-far; the rest streams behind the envelope. The
            // snapshot marks its entries shipped so they aren't sent twice.
            prefetchedData: ctx.serverQueries.snapshotResolved(),
            i18n,
            is404: !currentPathName,
            appId: pageData.appId,
            partial,
          };

          return new Response(
            createRoutePayloadStream(envelope, ctx.serverQueries, undefined, ({ aborted }) =>
              // No shell was marked, so the summary reports
              // `shellAt === settledAt` — the NDJSON body is one payload, not
              // a shell followed by streamed content.
              runInRequestScope(() =>
                this.completeStream(httpRequest, ctx.serverQueries.summarize(aborted)),
              ),
            ),
            {
              headers,
            },
          );
        }

        headers.set("Content-Type", "text/html; charset=utf-8");

        // The streamed/settled decision is UA-derived (crawlers get inline
        // settled documents), so the body varies by User-Agent and a shared
        // cache must key on it — otherwise a cached browser shell full of
        // fallbacks and reveal scripts gets served to a bot. `no-stream`
        // routes serve one settled body to everyone, so they stay cacheable
        // without the (CDN-hostile) Vary.
        if (!noStream) {
          headers.append("Vary", "User-Agent");
        }

        for (const cookie of cookies) {
          headers.append("Set-Cookie", cookie.toString());
        }

        // const { csrfToken, csrfTokenHMAC } = this.generateCSRFTokenWithHmac();

        const csrfToken = Bun.CSRF.generate(process.env.SECRET);
        headers.append(
          "Set-Cookie",
          `csrf_token=${csrfToken}; HttpOnly; Secure; SameSite=Strict; Expires=${new Date(Date.now() + 1000 * 60 * 60 * 24).toUTCString()}`,
        );

        try {
          await this.onRequestEnd(httpRequest);
        } catch (err) {
          Log.error(err?.message ?? 'Error in "onRequestEnd" event handler', {
            err: JSON.stringify(err),
          });
        }

        return await this.render({
          req: httpRequest,
          runInRequestScope,
          csrfTokenHMAC: Buffer.from(""),
          currentPathName,
          headers,
          i18n,
          params,
          pathname: url.pathname,
          serverQueries: ctx.serverQueries,
          userAgent: req.headers.get("user-agent"),
          noStream,
          url,
          user,
          viewData,
          breadcrumbs,
          urlLocaleSegment,
          meta: pageData.meta,
          appId: pageData.appId,
          isOgRequest,
        });
      } catch (err) {
        if (err.kind === GEMI_REQUEST_BREAKER_ERROR) {
          if (isViewDataRequest) {
            const { status = 400, data, directive, headers } = err.payload.api;
            return new Response(JSON.stringify({ data, directive }), {
              headers,
              status,
            });
          } else {
            const { status = 400, error } = err.payload.view;
            return new Response(error?.message, {
              ...err.payload.view,
              status,
            });
          }
        }
        // `Query.instant` rethrows the entry's error object into this catch —
        // already reported when the rejection settled, so skip the duplicate.
        if (!reportedQueryErrors.has(err)) {
          this.hooks.onRequestFail(httpRequest, err);
        }
        throw err;
      }
    });
  }
}
