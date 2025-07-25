import satori from "satori";
// @ts-ignore
import sharp from "sharp";

import { HttpRequest } from "../../http";
import type { Cookie } from "../../http/Cookie";
import { GEMI_REQUEST_BREAKER_ERROR } from "../../http/Error";
import { RequestContext } from "../../http/requestContext";
import type { RouterMiddleware } from "../../http/Router";
import {
  createFlatViewRoutes,
  type FlatViewRoutes,
  type ViewRouteExec,
} from "./createFlatViewRoutes";
import type { ViewRouterServiceProvider } from "./ViewRouterServiceProvider";
// @ts-ignore
import {
  renderToReadableStream,
  renderToString,
} from "react-dom/server.browser";
import { createElement, Fragment } from "react";

// @ts-ignore
import { URLPattern } from "urlpattern-polyfill/urlpattern";
import { ServiceContainer } from "../ServiceContainer";
import type { ViewRoutes } from "../../http/ViewRouter";
import { createRouteManifest } from "./createRouteManifest";
import { createComponentTree } from "./createComponentTree";
import { flattenComponentTree } from "../../client/helpers/flattenComponentTree";
import type { ComponentTree } from "../../client/types";
import { I18nServiceContainer } from "../../i18n/I18nServiceContainer";
import { MiddlewareServiceContainer } from "../middleware/MiddlewareServiceContainer";
import { Log } from "../../facades/Log";
import { I18n } from "../../facades/I18n";
import { AuthViewRouter } from "../../auth/AuthenticationServiceProvider";

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

export class ViewRouterServiceContainer extends ServiceContainer {
  static _name = "ViewRouterServiceContainer";

  flatViewRoutes: FlatViewRoutes = {};
  routeManifest: Record<string, string[]> = {};
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
    this.routeManifest = createRouteManifest(routes);
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

  private async render(props: {
    viewData: any;
    pathname: string;
    currentPathName: string;
    csrfTokenHMAC: Buffer;
    headers: any;
    url: URL;
    i18n: any;
    user: any;
    prefetchedData: any;
    params: any;
    breadcrumbs: any;
    urlLocaleSegment?: string;
    meta: any;
    isOgRequest?: boolean;
  }) {
    const {
      csrfTokenHMAC,
      currentPathName,
      headers,
      i18n,
      params,
      pathname,
      prefetchedData,
      url,
      user,
      viewData,
      breadcrumbs,
      urlLocaleSegment,
      meta,
      isOgRequest,
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
        prefetchedData,
        i18n,
        auth: { user },
        routeManifest: this.routeManifest,
        breadcrumbs,
        router: {
          urlLocaleSegment,
          pathname: currentPathName,
          params,
          currentPath: pathname,
          searchParams: url.search,
          is404: !currentPathName ? true : false,
        },
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
    }) => {
      const {
        bootstrapModules,
        loaders,
        getStyles,
        viewImportMap,
        cssManifest,
        ogMap,
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
          await renderToReadableStream(
            createElement(ogHandler, data[ogComponent]),
            {
              onError: () => {},
            },
          );
        } catch (err) {
          const { fonts, ...options } = err.satoriOptions;
          const _fonts = await Promise.all(
            fonts.map((font) => {
              return getTtfFont(font.name, font.weight, font.style).then(
                (data) => ({
                  ...font,
                  data,
                }),
              );
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

          return new Response(png, { headers: ogHeaders });
        }

        return new Response("data");
      }

      result.data["cssManifest"] = cssManifest;
      const stream = await renderToReadableStream(
        createElement(Fragment, {
          children: [
            ...(await getStyles(currentViews)),
            createElement("script", {
              key: "theme-script",
              dangerouslySetInnerHTML: {
                __html: themeScript,
              },
            }),
            createElement(Root, {
              data: result.data,
              viewImportMap,
              key: "root",
            }),
          ],
        }),
        {
          bootstrapScriptContent: `window.__GEMI_DATA__ = ${JSON.stringify(result.data)}; window.loaders=${loaders}`,
          bootstrapModules,
        },
      );

      return new Response(stream, {
        status: !currentPathName ? 404 : 200,
        headers,
      });
    };
  }

  async handleViewRequest(req: Request) {
    const url = new URL(req.url);
    const isViewDataRequest = url.pathname.endsWith(".json");
    const isOgRequest = url.pathname.endsWith(".og");
    const urlPathnameWithLocale = url.pathname
      .replace(".json", "")
      .replace(".og", "");

    const [, maybeLocale, ...rest] = urlPathnameWithLocale.split("/");
    let urlPathname = `/${rest.join("/")}`;
    let urlLocaleSegment = null;
    let urlLocale: string | null = null;

    const i18nServiceContainer = I18nServiceContainer.use();

    if (!i18nServiceContainer.service.supportedLocales.includes(maybeLocale)) {
      urlPathname = urlPathnameWithLocale;
    } else {
      urlLocaleSegment = maybeLocale;
      urlLocale = maybeLocale;
    }

    if (i18nServiceContainer.isEnabled && !isOgRequest) {
      const locale = I18nServiceContainer.use().detectLocale(
        new HttpRequest(req, {}, "view", urlPathname),
      );

      if (
        urlLocale === null &&
        locale !== i18nServiceContainer.service.defaultLocale
      ) {
        const locale = I18nServiceContainer.use().detectLocale(
          new HttpRequest(req, {}, "view", urlPathname),
        );
        const _pathname = url.pathname === "/" ? "" : url.pathname;
        return new Response("", {
          status: 302,
          headers: {
            "Cache-Control":
              "private, no-cache, no-store, max-age=0, must-revalidate",
            Location: `/${locale}${_pathname}`,
          },
        });
      }
    }

    urlPathname = urlPathname.replace("//", "/");
    let handlers: ViewRouteExec[] = [];
    let middlewares: (RouterMiddleware | string)[] = [];
    let currentPathName: null | string = null;
    let params: Record<string, any> = {};

    try {
      for (const [pathname, handler] of Object.entries(this.flatViewRoutes)) {
        const pattern = new URLPattern({ pathname });
        if (pattern.test({ pathname: urlPathname })) {
          currentPathName = pathname;
          params = pattern.exec({ pathname: urlPathname })?.pathname.groups!;
          handlers = handler.exec;
          middlewares = handler.middleware;
          break;
        }
      }
    } catch (err) {
      // TODO: Handle this
      throw err;
    }

    const httpRequest = new HttpRequest(req, params, "view", currentPathName);
    return await RequestContext.run(httpRequest, async () => {
      let pageData: {
        cookies: Set<Cookie>;
        headers: Headers;
        currentPathName: string;
        data: Record<string, any>;
        prefetchedData: Record<string, any>;
        user: any; // TODO: fix type
        params: Record<string, any>;
        urlLocaleSegment: string | null;
        meta: any;
      } | null = null;
      const ctx = RequestContext.getStore();

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

        const data = await Promise.all([
          ...handlers.map((fn) => fn(httpRequest as any)),
          ...Array.from(ctx.prefetchPromiseQueue).map((fn) => fn()),
        ]);

        const cookies = ctx.cookies;
        const headers = ctx.headers;
        const prefetchedResources = ctx.prefetchedResources;

        pageData = {
          data,
          cookies,
          headers,
          user: ctx.user,
          prefetchedData: Object.fromEntries(prefetchedResources.entries()),
          currentPathName: httpRequest.routePath,
          params: httpRequest.params,
          urlLocaleSegment,
          meta: ctx.renderMeta(),
        };
        const { params, currentPathName, user } = pageData;

        const viewData = {};
        const breadcrumbs = {};
        for (const part of data) {
          const [key, value] = Object.entries(part)?.[0] ?? [];
          if (!key || !value) {
            continue;
          }
          breadcrumbs[`${key}:${currentPathName}`] = (value as any).breadcrumb;
          viewData[key] = value;
        }

        if (isViewDataRequest) {
          headers.set("Content-Type", "application/json");

          cookies.forEach((cookie) =>
            headers.append("Set-Cookie", cookie.toString()),
          );

          await this.service.onRequestEnd(httpRequest);

          return new Response(
            JSON.stringify({
              meta: pageData.meta,
              data: {
                [urlPathname]: viewData,
              },
              breadcrumbs,
              prefetchedData: pageData.prefetchedData,
              i18n,
              is404: !currentPathName,
            }),
            {
              headers,
            },
          );
        }

        headers.set("Content-Type", "text/html");

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
          csrfTokenHMAC: Buffer.from(""),
          currentPathName,
          headers,
          i18n,
          params,
          pathname: url.pathname,
          prefetchedData: pageData.prefetchedData,
          url,
          user,
          viewData,
          breadcrumbs,
          urlLocaleSegment,
          meta: pageData.meta,
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
        } else {
          this.service.onRequestFail(httpRequest, err);
          throw err;
        }
      }
    });
  }
}
