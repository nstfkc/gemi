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
import { resolvePartialRender } from "./planPartialRender";
import { matchViewRoute } from "./matchViewRoute";
import { PARTIAL_RENDER_HEADER, type PartialRenderInfo } from "../../utils/partialRender";
import type { ViewRouterServiceProvider } from "./ViewRouterServiceProvider";
// @ts-ignore
import { renderToReadableStream } from "react-dom/server.browser";
import { createElement, Fragment } from "react";

import { ServiceContainer } from "../ServiceContainer";
import { createFileResponse, type FileOutput, type ViewRoutes } from "../../http/ViewRouter";
import { createRouteManifest } from "./createRouteManifest";
import { createComponentTree } from "./createComponentTree";
import { flattenComponentTree } from "../../client/helpers/flattenComponentTree";
import type { ComponentTree } from "../../client/types";
import { I18nServiceContainer } from "../../i18n/I18nServiceContainer";
import { MiddlewareServiceContainer } from "../middleware/MiddlewareServiceContainer";
import { Log } from "../../facades/Log";
import { I18n } from "../../facades/I18n";
import { AuthViewRouter } from "../../auth/AuthenticationServiceProvider";
import { KernelIdServiceContainer } from "../kernel-id/KernelIdServiceContainer";
import { ServerQueryStore, type StreamSummary } from "./ServerQueryStore";
import { createServerQueryFetcher } from "./serverQueryFetcher";
import { injectQueryPayloads, isBotUserAgent } from "./streamQueryInjection";
import { createRoutePayloadStream } from "./routePayloadStream";

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

export class ViewRouterServiceContainer extends ServiceContainer {
  static _name = "ViewRouterServiceContainer";

  flatViewRoutes: FlatViewRoutes = {};
  routeManifest: Record<string, string[]> = {};
  /** `routeManifest` without file routes — they have no component to render client side. */
  clientRouteManifest: Record<string, string[]> = {};
  componentTree: ComponentTree = [];
  flatComponentTree: string[] = [];
  root: any = null;

  constructor(public service: ViewRouterServiceProvider) {
    super();
    const routes: ViewRoutes = {
      "/": service.rootRouter,
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
    this.root = service.root;
  }

  boot() {}

  async onRequestEnd(req: HttpRequest) {
    if (!req.cookies.has("session_id")) {
      req.ctx().setCookie("session_id", Bun.randomUUIDv7(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Strict",
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
    }

    return await this.service.onRequestEnd(req);
  }

  /**
   * Fires the provider's `onStreamComplete` from a stream callback — an
   * observability hook must never break the response body it observes, so
   * sync throws and rejections are logged and swallowed.
   */
  private completeStream(req: HttpRequest, summary: StreamSummary) {
    const logError = (err: any) => {
      Log.error(err?.message ?? 'Error in "onStreamComplete" event handler', {
        err: JSON.stringify(err),
      });
    };
    try {
      Promise.resolve(this.service.onStreamComplete(req, summary)).catch(logError);
    } catch (err) {
      logError(err);
    }
  }

  private async render(props: {
    req: HttpRequest;
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
      bootstrapModules: string[];
      loaders: string;
      cssManifest: Record<string, string[]>;
      ogMap: Record<string, any>;
      /**
       * Full view modules (not just default exports) so `Route` can render a
       * view's `Loading`/`Error` exports on the server — a streamed shell
       * carries real fallbacks, and they must match what the client hydrates.
       */
      viewModules?: Record<string, any>;
    }) => {
      const {
        bootstrapModules,
        loaders,
        getStyles,
        viewImportMap,
        cssManifest,
        ogMap,
        viewModules,
      } = params;

      if (isOgRequest) {
        let ogHandler = null;
        let ogComponent = null;
        for (const view of currentViews) {
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

      try {
        const stream = await renderToReadableStream(
          createElement(Fragment, {
            children: [
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
            bootstrapScriptContent: `window.__GEMI_DATA__ = ${JSON.stringify(result.data)}; window.loaders=${loaders}`,
            bootstrapModules,
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
            // The APM-visible end of the request: the body closed, not the
            // handler returned (that was at time-to-shell).
            onClose: () => {
              this.completeStream(req, serverQueries.summarize(deadline.signal.aborted));
            },
          }),
          {
            status: !currentPathName ? 404 : 200,
            headers,
          },
        );
      } catch (err) {
        clearTimeout(deadlineTimer);
        const stream = await renderToReadableStream(createElement("div"), {
          bootstrapScriptContent: `window.error= ${JSON.stringify(err.message)}; window.stack_trace=${JSON.stringify(err.stack)};window.__GEMI_DATA__ = ${JSON.stringify(result.data)}; window.loaders=${loaders}`,
          bootstrapModules:
            process.env.NODE_ENV === "development"
              ? ["/render-error.js", ...bootstrapModules]
              : bootstrapModules,
        });
        return new Response(stream, {
          status: !currentPathName ? 404 : 200,
          headers,
        });
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

    const i18nServiceContainer = I18nServiceContainer.use();

    const isPathnameWithLocale =
      !i18nServiceContainer.service.supportedLocales.includes(maybeLocale);

    if (isPathnameWithLocale) {
      urlPathname = urlPathnameWithLocale;
    } else {
      urlLocaleSegment = maybeLocale;
      urlLocale = maybeLocale;
    }

    if (i18nServiceContainer.isEnabled && !isOgRequest) {
      const locale = I18nServiceContainer.use().detectLocale(
        new HttpRequest(req, {}, "view", urlPathname),
      );

      if (urlLocale === null && locale !== i18nServiceContainer.service.defaultLocale) {
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
        if (isViewDataRequest && this.service.partialRendering) {
          const from = req.headers.get(PARTIAL_RENDER_HEADER);
          const plan = resolvePartialRender({
            flatViewRoutes: this.flatViewRoutes,
            supportedLocales: i18nServiceContainer.service.supportedLocales,
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
          Promise.resolve(this.service.onRequestFail(httpRequest, entry.error)).catch(
            () => {},
          );
        } catch {
          // An error-reporting hook must not break the settle chain it
          // observes — a suspended segment is waiting on it.
        }
      });

      if (urlLocale) {
        const locale = urlLocale.replaceAll("/", "");
        I18n.setLocale(locale);
      } else {
        I18n.setLocale();
      }

      const httpRequest = ctx.req;

      try {
        await MiddlewareServiceContainer.use().runMiddleware(middlewares);

        const i18nServiceContainer = I18nServiceContainer.use();
        const isI18nEnabled = i18nServiceContainer.isEnabled;
        let i18n: Record<string, any> = {};
        if (isI18nEnabled) {
          let locale = null;
          if (urlLocale) {
            locale = urlLocale.replaceAll("/", "");
            ctx.setLocale(locale);
          } else {
            locale = i18nServiceContainer.detectLocale(
              new HttpRequest(req, httpRequest.params as any),
            );
            ctx.setLocale(locale);
          }

          const translations = i18nServiceContainer.getPageTranslations(
            locale,
            httpRequest.routePath,
          );

          i18n = {
            supportedLocales: i18nServiceContainer.service.supportedLocales,
            currentLocale: locale,
            dictionary: {
              [locale]: translations,
            },
            defaultLocale: i18nServiceContainer.service.defaultLocale,
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
          appId: KernelIdServiceContainer.use().service.id,
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

          await this.service.onRequestEnd(httpRequest);

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
              this.completeStream(httpRequest, ctx.serverQueries.summarize(aborted)),
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
          this.service.onRequestFail(httpRequest, err);
        }
        throw err;
      }
    });
  }
}
