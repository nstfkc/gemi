import { HttpRequest } from "../../http";
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
import { createRouteManifest } from "./createRouteManifest";
import { createComponentTree } from "./createComponentTree";
import { flattenComponentTree } from "../../client/helpers/flattenComponentTree";
import type { ComponentTree } from "../../client/types";
import { I18nServiceContainer } from "../../http/I18nServiceContainer";
import { MiddlewareServiceContainer } from "../middleware/MiddlewareServiceContainer";
import { Log } from "../../facades";

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
    };
    this.flatViewRoutes = createFlatViewRoutes(routes);
    this.routeManifest = createRouteManifest(routes);
    this.componentTree = createComponentTree(routes);
    this.flatComponentTree = flattenComponentTree(this.componentTree);
    this.root = service.root;
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

    let httpRequest: HttpRequest | null = null;

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

      httpRequest = new HttpRequest(req, params, "view", currentPathName);
      try {
        await this.service.onRequestStart(httpRequest);
      } catch (err) {
        Log.error(err?.message ?? 'Error in "onRequestStart" event handler', {
          err: JSON.stringify(err),
        });
      }
      const { data, cookies, headers, user, prefetchedData } =
        await RequestContext.run(httpRequest, async () => {
          const ctx = RequestContext.getStore();
          ctx.setRequest(httpRequest);

          await MiddlewareServiceContainer.use().runMiddleware(middlewares);

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
      console.log("ERROR", err);
      console.log("ERROR KIND", err.kind);
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
      const headers = new Headers(pageData.headers);

      headers.set("Content-Type", "application/json");

      cookies.forEach((cookie) =>
        headers.append("Set-Cookie", cookie.toString()),
      );

      await this.service.onRequestEnd(httpRequest);

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

    const headers = new Headers(pageData.headers);
    headers.set("Content-Type", "text/html");

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
    const Root = this.root;
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
            createElement(Root, {
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

      try {
        await this.service.onRequestEnd(httpRequest);
      } catch (err) {
        Log.error(err?.message ?? 'Error in "onRequestEnd" event handler', {
          err: JSON.stringify(err),
        });
      }
      return new Response(stream, {
        status: !currentPathName ? 404 : 200,
        headers,
      });
    };
  }
}
