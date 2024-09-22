import type { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
// @ts-ignore
import { URLPattern } from "urlpattern-polyfill";
import { generateETag } from "../server/generateEtag";
import type { ComponentTree } from "../client/types";
import { type RouterMiddleware } from "../http/Router";
import { GEMI_REQUEST_BREAKER_ERROR } from "../http/Error";
import type { Plugin } from "./Plugin";
import type { Middleware } from "../http/Middleware";
import { RequestContext } from "../http/requestContext";
import { type Cookie } from "../http/Cookie";
import type { WebSocketHandler } from "bun";
import { flattenComponentTree } from "../client/helpers/flattenComponentTree";

import { createComponentTree } from "./createComponentTree";
import {
  createFlatViewRoutes,
  type ViewRouteExec,
} from "./createFlatViewRoutes";
import { createRouteManifest } from "./createRouteManifest";

// @ts-ignore
import { renderToReadableStream } from "react-dom/server.browser";
import { ComponentType, createElement, Fragment } from "react";

import { HttpRequest } from "../http";
import { Kernel } from "../kernel";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { KernelContext } from "../kernel/KernelContext";

interface RenderParams {
  styles: string[];
  manifest: Record<string, any>;
  serverManifest: Record<string, any>;
  bootstrapModules?: string[];
}

interface AppParams {
  viewRouter: new () => ViewRouter;
  apiRouter: new () => ApiRouter;
  plugins?: (new () => Plugin)[];
  middlewareAliases?: Record<string, new () => Middleware>;
  root: ComponentType;
  kernel: new () => Kernel;
}

export class App {
  private renderParams: RenderParams = {
    styles: [],
    manifest: {},
    serverManifest: {},
    bootstrapModules: [],
  };
  private flatViewRoutes: Record<
    string,
    { exec: ViewRouteExec[]; middleware: any[] }
  > = {};

  private routeManifest: Record<string, string[]> = {};
  public name = "APP";
  private appId: string;
  private componentTree: ComponentTree;
  public middlewareAliases: Record<string, new () => Middleware> = {};
  public devVersion = 0;
  private params: AppParams;
  private apiRouter: new () => ApiRouter;
  private viewRouter: new () => ViewRouter;
  private Root: ComponentType;
  private kernel: Kernel;
  private i18nServiceContainer: I18nServiceContainer;
  private flatComponentTree: string[] = [];

  constructor(params: AppParams) {
    this.params = params;
    this.apiRouter = params.apiRouter;
    this.viewRouter = params.viewRouter;
    this.Root = params.root;
    this.kernel = new params.kernel();

    this.prepare();
    this.appId = generateETag(Date.now());

    this.i18nServiceContainer = this.kernel.getServices().i18nServiceContainer;
    this.i18nServiceContainer.boot();
  }

  private prepare() {
    const params = this.params;
    this.middlewareAliases = params.middlewareAliases ?? {};

    const kernelServices = this.kernel.getServices();

    const authBasePath = kernelServices.authenticationServiceProvider.basePath;

    let viewRouters = {
      "/": this.viewRouter,
      [authBasePath]: kernelServices.authenticationServiceProvider.routers.view,
    };
    let apiRouters = {
      "/": this.apiRouter,
      [authBasePath]: kernelServices.authenticationServiceProvider.routers.api,
      "/__gemi__/services/i18n":
        kernelServices.i18nServiceContainer.routers.api,
    };

    for (const Plugin of params.plugins ?? []) {
      const plugin = new Plugin();
      if (plugin.viewRouter) {
        viewRouters = {
          ...viewRouters,
          [plugin.viewRoutesBasePath]: plugin.viewRouter,
        };
      }
      if (plugin.apiRouter) {
        apiRouters = {
          ...apiRouters,
          [plugin.apiRoutesBasePath]: plugin.apiRouter,
        };
      }
    }

    this.kernel
      .getServices()
      .apiRouterServiceContainer.service.boot(apiRouters);
    this.flatViewRoutes = createFlatViewRoutes(viewRouters);
    this.componentTree = createComponentTree(viewRouters);
    this.flatComponentTree = flattenComponentTree(this.componentTree);
    this.routeManifest = createRouteManifest(viewRouters);
  }

  public getComponentTree() {
    return this.componentTree;
  }

  public setRenderParams(params: RenderParams) {
    this.renderParams = params;
  }

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

          await KernelContext.getStore().middlewareServiceContainer.runMiddleware(
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

    const isI18nEnabled = this.i18nServiceContainer.isEnabled;
    let i18n: Record<string, any> = {};
    if (isI18nEnabled) {
      const locale = this.i18nServiceContainer.detectLocale(
        new HttpRequest(req, params as any),
      );
      const translations = this.i18nServiceContainer.getPageTranslations(
        locale,
        currentPathName,
      );

      i18n = {
        [locale]: translations,
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

    const { styles, manifest, serverManifest, bootstrapModules } =
      this.renderParams;

    const viewImportMap = {};
    let appDir: string | null = null;
    const template = (viewName: string, path: string) =>
      `"${viewName}": () => import("${path}")`;
    const templates = [];

    for (const fileName of ["404", ...this.flatComponentTree]) {
      if (process.env.NODE_ENV === "test") {
        break;
      }
      if (!manifest) {
        appDir = `${process.env.APP_DIR}`;
        const mod = await import(
          `${appDir}/views/${fileName}.tsx?t=${this.appId}`
        );
        viewImportMap[fileName] = mod.default;
        templates.push(
          template(fileName, `${appDir}/views/${fileName}.tsx?t=${this.appId}`),
        );
      } else {
        const serverFile = serverManifest[`app/views/${fileName}.tsx`];
        if (!serverFile?.file) {
          console.log(`Server file not found for ${fileName}`);
          console.log(serverFile);
          const files = Object.keys(serverManifest);
          const path = `app/views/${fileName}.tsx`;
          console.log(`${path} not found in server manifest`);
          console.log(files);
        }
        const mod = await import(
          `${process.env.DIST_DIR}/server/${serverFile?.file}?t=${this.appId}`
        );

        viewImportMap[fileName] = mod.default;
        const clientFile = manifest[`app/views/${fileName}.tsx`];
        if (clientFile) {
          templates.push(
            template(fileName, `/${clientFile?.file}?t=${this.appId}`),
          );
        }
      }
    }

    const loaders = `{${templates.join(",")}}`;

    const headers = new Headers();
    headers.set("Content-Type", "text/html");
    headers.set(
      "Cache-Control",
      user
        ? "private, no-cache, no-store, max-age=0, must-revalidate"
        : "public, max-age=864000, must-revalidate",
    );
    headers.set("ETag", this.appId);

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

    const stream = await renderToReadableStream(
      createElement(Fragment, {
        children: [
          styles,
          createElement(this.Root as any, {
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
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    const kernelRun = this.kernel.run.bind(this.kernel);

    return kernelRun(async () => {
      if (url.pathname.startsWith("/api")) {
        return await this.kernel.services.apiRouterServiceContainer.handleApiRequest(
          req,
        );
      } else {
        return await this.handleViewRequest(req);
      }
    });
  }

  public websocket: WebSocketHandler<{ headers: Headers }> = {
    message: (ws, message) => {
      const kernelRun = this.kernel.run.bind(this.kernel);
      kernelRun(() => {
        KernelContext.getStore().broadcastingServiceContainer.run(
          ws.data.headers,
          () => {
            KernelContext.getStore().broadcastingServiceContainer.handleMessage(
              ws,
              message,
            );
          },
        );
      });
    },
    open: (_ws) => {},
    close: (ws) => {
      console.log("closed ws");
      ws.terminate();
    },
  };

  public onPublish(
    fn: (
      topic: string,
      data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
      compress?: boolean,
    ) => void,
  ) {
    this.kernel.services.broadcastingServiceContainer.onPublish(fn);
  }
}
