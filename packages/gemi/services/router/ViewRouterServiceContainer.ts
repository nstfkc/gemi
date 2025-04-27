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
import { I18nServiceContainer } from "../../i18n/I18nServiceContainer";
import { MiddlewareServiceContainer } from "../middleware/MiddlewareServiceContainer";
import { Log } from "../../facades/Log";
import { I18n } from "../../facades/I18n";
import { AuthViewRouter } from "../../auth/AuthenticationServiceProvider";

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
    } = props;

    const result = {
      kind: "view",
      data: {
        pageData: {
          [pathname]: viewData,
        },
        __csrf: csrfTokenHMAC.toString("base64"),
        prefetchedData,
        i18n,
        auth: { user },
        routeManifest: this.routeManifest,
        breadcrumbs,
        router: {
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
    }) => {
      const {
        bootstrapModules,
        loaders,
        getStyles,
        viewImportMap,
        cssManifest,
      } = params;

      result.data["cssManifest"] = cssManifest;
      const stream = await renderToReadableStream(
        createElement(Fragment, {
          children: [
            ...(await getStyles(currentViews)),
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
    const urlPathname = url.pathname.replace(".json", "");

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
      I18n.setLocale();
      let pageData: {
        cookies: Set<Cookie>;
        headers: Headers;
        currentPathName: string;
        data: Record<string, any>;
        prefetchedData: Record<string, any>;
        user: any; // TODO: fix type
        params: Record<string, any>;
      } | null = null;
      const ctx = RequestContext.getStore();

      const httpRequest = ctx.req;

      try {
        await MiddlewareServiceContainer.use().runMiddleware(middlewares);

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
          headers.set("Content-Type", "application/json");

          cookies.forEach((cookie) =>
            headers.append("Set-Cookie", cookie.toString()),
          );

          await this.service.onRequestEnd(httpRequest);

          return new Response(
            JSON.stringify({
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
