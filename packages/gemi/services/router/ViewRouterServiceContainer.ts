import { HttpRequest } from "../../http";
import { createRoot } from "../../client/createRoot";

import { Cookie } from "../../http/Cookie";
import { GEMI_REQUEST_BREAKER_ERROR } from "../../http/Error";
import { RequestContext } from "../../http/requestContext";
import type { RouterMiddleware } from "../../http/Router";
import {
  createFlatViewRoutes,
  FlatViewRoutes,
  type ViewRouteExec,
} from "./createFlatViewRoutes";
import { ViewRouterServiceProvider } from "./ViewRouterServiceProvider";
// @ts-ignore
import { renderToReadableStream } from "react-dom/server.browser";
import { createElement, Fragment } from "react";

// @ts-ignore
import { URLPattern } from "urlpattern-polyfill/urlpattern";
import { ServiceContainer } from "../ServiceContainer";
import type { ViewRoutes } from "../../http/ViewRouter";
import { AuthViewRouter } from "../../auth/AuthenticationServiceProvider";
import { createRouteManifest } from "./createRouteManifest";
import { createComponentTree } from "./createComponentTree";
import { flattenComponentTree } from "../../client/helpers/flattenComponentTree";
import type { ComponentTree } from "../../client/types";
import { I18nServiceContainer } from "../../http/I18nServiceContainer";
import { MiddlewareServiceContainer } from "../middleware/MiddlewareServiceContainer";

export class ViewRouterServiceContainer extends ServiceContainer {
  name = "ViewRouterServiceContainer";

  flatViewRoutes: FlatViewRoutes = {};
  routeManifest: Record<string, string[]> = {};
  componentTree: ComponentTree = [];
  flatComponentTree: string[] = [];
  RootLayout: any = null;

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
    this.RootLayout = createRoot(service.rootLayout);
  }

  boot() {}

  async handleViewRequest(req: Request) {
    const url = new URL(req.url);
    const isViewDataRequest = url.searchParams.get("json");

    let pageData: {
      cookies: Set<Cookie>;
      headers: Headers;
      currentPathName: string;
      data: Record<string, any>;
      prefetchedData: Record<string, any>;
      user: any; // TODO: fix type
      params: Record<string, any>;
    } | null = null;

    try {
      let handlers: ViewRouteExec[] = [];
      let middlewares: (RouterMiddleware | string)[] = [];
      let currentPathName: null | string = null;
      let params: Record<string, any> = {};

      for (const [pathname, handler] of Object.entries(this.flatViewRoutes)) {
        const pattern = new URLPattern({ pathname });
        if (pattern.test({ pathname: url.pathname })) {
          currentPathName = pathname;
          params = pattern.exec({ pathname: url.pathname })?.pathname.groups!;
          handlers = handler.exec;
          middlewares = handler.middleware;
          break;
        }
      }

      const httpRequest = new HttpRequest(req, params);
      const { data, cookies, headers, user, prefetchedData } =
        await RequestContext.run(httpRequest, async () => {
          const ctx = RequestContext.getStore();
          ctx.setRequest(httpRequest);

          await MiddlewareServiceContainer.use().runMiddleware(
            middlewares,
            currentPathName,
          );

          const data = await Promise.all([
            ...handlers.map((fn) => fn(httpRequest as any)),
            ...Array.from(ctx.prefetchPromiseQueue).map((fn) => fn()),
          ]);

          const cookies = ctx.cookies;
          const headers = ctx.headers;
          const prefetchedResources = ctx.prefetchedResources;

          return {
            data,
            cookies,
            headers,
            user: ctx.user,
            prefetchedData: Object.fromEntries(prefetchedResources.entries()),
          };
        });

      pageData = {
        data,
        prefetchedData,
        currentPathName,
        user,
        params,
        cookies,
        headers,
      };
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
        throw err;
      }
    }

    const { data, params, currentPathName, user, cookies } = pageData;

    const viewData = data.reduce((acc, data) => {
      return {
        ...acc,
        ...data,
      };
    }, {});
    const i18nServiceContainer = I18nServiceContainer.use();
    const isI18nEnabled = i18nServiceContainer.isEnabled;
    let i18n: Record<string, any> = {};
    if (isI18nEnabled) {
      const locale = i18nServiceContainer.detectLocale(
        new HttpRequest(req, params as any),
      );
      const translations = i18nServiceContainer.getPageTranslations(
        locale,
        currentPathName,
      );

      i18n = {
        supportedLocales: i18nServiceContainer.supportedLocales,
        currentLocale: locale,
        dictionary: {
          [locale]: translations,
        },
      };
    }

    if (isViewDataRequest) {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");

      cookies.forEach((cookie) =>
        headers.append("Set-Cookie", cookie.toString()),
      );

      headers.append(
        "Cache-Control",
        user
          ? "private, no-cache, no-store, max-age=0, must-revalidate"
          : "public, max-age=864000, must-revalidate",
      );

      return new Response(
        JSON.stringify({
          data: {
            [url.pathname]: viewData,
          },
          prefetchedData: pageData.prefetchedData,
          i18n,
          is404: !currentPathName,
        }),
        {
          headers,
        },
      );
    }

    const headers = new Headers();
    headers.set("Content-Type", "text/html");
    headers.set(
      "Cache-Control",
      user
        ? "private, no-cache, no-store, max-age=0, must-revalidate"
        : "public, max-age=864000, must-revalidate",
    );
    headers.set("ETag", 'W/"' + Math.random().toString(36).substring(7) + '"');

    pageData.cookies.forEach((cookie) =>
      headers.append("Set-Cookie", cookie.toString()),
    );

    const result = {
      kind: "view",
      data: {
        pageData: {
          [url.pathname]: viewData,
        },
        prefetchedData: pageData.prefetchedData,
        i18n,
        auth: { user },
        routeManifest: this.routeManifest,
        router: {
          pathname: currentPathName,
          params,
          currentPath: url.pathname,
          searchParams: url.search,
          is404: !currentPathName ? true : false,
        },
        componentTree: [["404", []], ...this.componentTree],
      },
      head: {},
    };
    const Root = this.RootLayout;
    return async (params: {
      styles: any[];
      viewImportMap: any;
      bootstrapModules: string[];
      loaders: string;
    }) => {
      const { bootstrapModules, loaders, styles, viewImportMap } = params;
      const stream = await renderToReadableStream(
        createElement(Fragment, {
          children: [
            styles,
            createElement(Root as any, {
              data: result.data,
              viewImportMap,
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
}
