import type { ApiRouter } from "../http/ApiRouter";
import { ViewRouter, type ViewRouteExec } from "../http/ViewRouter";
// @ts-ignore
import { URLPattern } from "urlpattern-polyfill";
import { generateETag } from "../server/generateEtag";
import { v4 } from "uuid";
import type { ComponentTree } from "../client/types";
import { type RouterMiddleware } from "../http/Router";
import type { UnwrapPromise } from "../utils/type";
import { GEMI_REQUEST_BREAKER_ERROR } from "../http/Error";
import type { Plugin } from "./Plugin";
import type { Middleware } from "../http/Middleware";
import { requestContext } from "../http/requestContext";
import type { ServerWebSocket } from "bun";
import { flattenComponentTree } from "../client/helpers/flattenComponentTree";

import { createComponentTree } from "./createComponentTree";
import { createFlatViewRoutes } from "./createFlatViewRoutes";
import { createRouteManifest } from "./createRouteManifest";
import { createFlatApiRoutes } from "./createFlatApiRoutes";

// @ts-ignore
import { renderToReadableStream } from "react-dom/server.browser";
import { ComponentType, createElement, Fragment } from "react";

import { isConstructor } from "../internal/isConstructor";
import { HttpRequest } from "../http";
import { Kernel } from "../kernel";

type ApiRouteExec = any; // TODO: fix type

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
  private flatApiRoutes: Record<
    string,
    Record<
      string,
      {
        exec: ApiRouteExec;
        middleware: (string | (new () => Middleware) | RouterMiddleware)[];
      }
    >
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

  constructor(params: AppParams) {
    this.params = params;
    this.apiRouter = params.apiRouter;
    this.viewRouter = params.viewRouter;
    this.Root = params.root;
    this.kernel = new params.kernel();

    this.prepare();
    this.appId = generateETag(Date.now());
  }

  private prepare() {
    const params = this.params;
    this.middlewareAliases = params.middlewareAliases ?? {};

    let viewRouters = {
      "/": this.viewRouter,
    };
    let apiRouters = {
      "/": this.apiRouter,
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
    this.flatViewRoutes = createFlatViewRoutes(viewRouters);
    this.componentTree = createComponentTree(viewRouters);
    this.routeManifest = createRouteManifest(viewRouters);
    // Handle view routes

    // Handle api routes
    this.flatApiRoutes = createFlatApiRoutes(apiRouters);
  }

  public getComponentTree() {
    return this.componentTree;
  }

  public setRenderParams(params: RenderParams) {
    this.renderParams = params;
  }

  private async resolvePageData(req: Request) {
    const url = new URL(req.url);
    let handlers: ViewRouteExec[] = [];
    let middlewares: (RouterMiddleware | string)[] = [];
    let currentPathName = "";
    let params: Record<string, any> = {};
    const sortedEntries = Object.entries(this.flatViewRoutes).sort(
      ([pathA], [pathB]) => pathB.length - pathA.length,
    );

    for (const [pathname, handler] of sortedEntries) {
      const pattern = new URLPattern({ pathname });
      if (pattern.test({ pathname: url.pathname })) {
        currentPathName = pathname;
        params = pattern.exec({ pathname: url.pathname })?.pathname.groups!;
        handlers = handler.exec;
        middlewares = handler.middleware;
      }
    }

    const reqWithMiddlewares = this.runMiddleware(middlewares);

    const reqCtx = new Map();

    const data = await requestContext.run(reqCtx, async () => {
      await reqWithMiddlewares(new HttpRequest(req, params), reqCtx);
      return await Promise.all(handlers.map((fn) => fn(req, params, this)));
    });

    return {
      data,
      currentPathName,
      params,
      user: reqCtx.get("user") ?? null,
    };
  }

  private runMiddleware(
    middleware: (string | RouterMiddleware | (new () => Middleware))[],
  ) {
    return middleware
      .map((aliasOrTest) => {
        if (typeof aliasOrTest === "string") {
          const alias = aliasOrTest;
          if (this.middlewareAliases?.[alias]) {
            const middleware = new this.middlewareAliases[alias]();
            return middleware.run;
          }
        } else {
          if (isConstructor(aliasOrTest)) {
            // TODO: fix type
            // @ts-ignore
            const middleware = new aliasOrTest();
            return middleware.run;
          }
          return aliasOrTest;
        }
      })
      .filter(Boolean)
      .reduce(
        (acc: any, middleware: any) => {
          return async (req: HttpRequest<any, any>, ctx: any) => {
            return {
              ...(await acc(req, ctx)),
              ...(await middleware(req, ctx)),
            };
          };
        },
        (_req: HttpRequest<any, any>) => Promise.resolve({}),
      );
  }

  async handleApiRequest(req: Request) {
    const url = new URL(req.url);

    const apiPath = url.pathname.replace("/api", "");
    for (const [path, handler] of Object.entries(this.flatApiRoutes)) {
      const pattern = new URLPattern({ pathname: path });
      if (pattern.test({ pathname: apiPath })) {
        const params = pattern.exec({ pathname: apiPath })?.pathname.groups!;
        if (!handler[req.method]) {
          return new Response(
            JSON.stringify({ error: { message: "Not found" } }),
          );
        }
        const exec = handler[req.method].exec;
        const middlewares = handler[req.method].middleware;

        const reqWithMiddlewares = this.runMiddleware(middlewares);

        const reqCtx = new Map();

        return await requestContext.run(reqCtx, async () => {
          const httpRequest = new HttpRequest(req, params);
          let handler = exec
            ? () => exec(httpRequest, params, this)
            : () => Promise.resolve({});

          try {
            await reqWithMiddlewares(httpRequest, reqCtx);
          } catch (err) {
            if (err.kind === GEMI_REQUEST_BREAKER_ERROR) {
              const { status = 400, data, headers } = err.payload.api;

              return new Response(JSON.stringify(data), {
                status,
                headers: {
                  "Content-Type": "application/json",
                  ...headers,
                },
              });
            } else {
              throw err;
            }
          }

          let data = {};
          try {
            data = await handler();
          } catch (err) {
            if (err.kind === GEMI_REQUEST_BREAKER_ERROR) {
              const { status = 400, data, headers } = err.payload.api;

              return new Response(JSON.stringify(data), {
                status,
                headers: {
                  "Content-Type": "application/json",
                  ...headers,
                },
              });
            } else {
              throw err;
            }
          }

          const result = {
            kind: "api",
            data,
            headers: {
              "Set-Cookie": Object.entries({})
                .map(([name, config]) => {
                  return `${name}=${(config as any).value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${(config as any).maxAge}`;
                })
                .join(", "),
            },
          };
          return new Response(JSON.stringify(result.data), {
            headers: {
              "Content-Type": "application/json",
              ...result.headers,
            },
          });
        });
      }
    }

    return new Response(JSON.stringify({ error: { message: "Not found" } }), {
      status: 404,
    });
  }

  async handleViewRequest(req: Request) {
    const url = new URL(req.url);

    let pageData: UnwrapPromise<
      ReturnType<typeof this.resolvePageData>
    > | null = null;

    try {
      let handlers: ViewRouteExec[] = [];
      let middlewares: (RouterMiddleware | string)[] = [];
      let currentPathName: null | string = null;
      let params: Record<string, any> = {};
      const sortedEntries = Object.entries(this.flatViewRoutes).sort(
        ([pathA], [pathB]) => pathB.length - pathA.length,
      );

      for (const [pathname, handler] of sortedEntries) {
        const pattern = new URLPattern({ pathname });
        if (pattern.test({ pathname: url.pathname })) {
          currentPathName = pathname;
          params = pattern.exec({ pathname: url.pathname })?.pathname.groups!;
          handlers = handler.exec;
          middlewares = handler.middleware;
        }
      }

      const reqWithMiddlewares = this.runMiddleware(middlewares);

      const reqCtx = new Map();

      const data = await requestContext.run(reqCtx, async () => {
        await reqWithMiddlewares(new HttpRequest(req, params), reqCtx);
        return await Promise.all(handlers.map((fn) => fn(req, params, this)));
      });

      pageData = {
        data,
        currentPathName,
        params,
        user: reqCtx.get("user") ?? null,
      };
    } catch (err) {
      if (err.kind === GEMI_REQUEST_BREAKER_ERROR) {
        return new Response(null, {
          ...err.payload.view,
        });
      }
    }

    const { data, params, currentPathName, user } = pageData;

    const viewData = data.reduce((acc, data) => {
      return {
        ...acc,
        ...data,
      };
    }, {});

    if (url.searchParams.get("json")) {
      const result = {
        kind: "viewData",
        data: {
          [url.pathname]: viewData,
        },
        meta: [],
        headers: {},
      };

      return new Response(
        JSON.stringify({
          data: result.data,
          head: {},
        }),
        {
          headers: {
            ...result.headers,
            "Content-Type": "application/json",
          },
        },
      );
    }

    let cookieHeaders = {};
    const visitorIdExist = req.headers.get("cookie")?.includes("visitor_id");
    if (!visitorIdExist) {
      cookieHeaders = {
        "Set-Cookie": `visitor_id=${v4()}; HttpOnly; SameSite=Strict; Path=/`,
      };
    }

    const { styles, manifest, serverManifest, bootstrapModules } =
      this.renderParams;

    const viewImportMap = {};
    let appDir: string | null = null;
    const template = (viewName: string, path: string) =>
      `"${viewName}": () => import("${path}")`;
    const templates = [];

    for (const fileName of [
      "404",
      ...flattenComponentTree(this.componentTree),
    ]) {
      if (process.env.NODE_ENV === "test") {
        break;
      }
      if (!manifest) {
        appDir = `${process.env.APP_DIR}`;
        const mod = await import(`${appDir}/views/${fileName}.tsx`);
        viewImportMap[fileName] = mod.default;
        templates.push(template(fileName, `${appDir}/views/${fileName}.tsx`));
      } else {
        const serverFile = serverManifest[`app/views/${fileName}.tsx`];
        const mod = await import(
          `${process.env.DIST_DIR}/server/${serverFile?.file}`
        );
        viewImportMap[fileName] = mod.default;
        const clientFile = manifest[`app/views/${fileName}.tsx`];
        if (clientFile) {
          templates.push(template(fileName, `/${clientFile?.file}`));
        }
      }
    }

    const loaders = `{${templates.join(",")}}`;

    const result = {
      kind: "view",
      data: {
        pageData: {
          [url.pathname]: viewData,
        },
        auth: { user },
        routeManifest: this.routeManifest,
        router: {
          pathname: currentPathName,
          params,
          currentPath: url.pathname,
          is404: !currentPathName ? true : false,
        },
        componentTree: [["404", []], ...this.componentTree],
      },
      head: {},
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": user
          ? "private, no-cache, no-store, max-age=0, must-revalidate"
          : "public, max-age=864000, must-revalidate",
        ETag: this.appId,
        ...cookieHeaders,
      },
      status: !currentPathName ? 404 : 200,
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
      status: result.status,
      headers: {
        "Content-Type": "text/html",
        ...result.headers,
      },
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    return this.kernel.run(async () => {
      if (url.pathname.startsWith("/api")) {
        return await this.handleApiRequest(req);
      } else {
        return await this.handleViewRequest(req);
      }
    });
  }

  private handleWebSocketMessage = (
    ws: ServerWebSocket,
    message: string | Buffer,
  ) => {};
  private handleWebSocketOpen = (ws: ServerWebSocket) => {
    console.log("socket opened");
  };
  private handleWebSocketClose = (
    ws: ServerWebSocket,
    code: number,
    reason: string,
  ) => {
    console.log("socket closed");
  };

  websocket = {
    message: this.handleWebSocketMessage,
    open: this.handleWebSocketOpen,
    close: this.handleWebSocketClose,
  };
}
