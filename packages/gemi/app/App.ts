import type {
  ApiRouteChildren,
  ApiRouteExec,
  ApiRouter,
} from "../http/ApiRouter";
import { ViewRouter, type ViewRouteExec } from "../http/ViewRouter";
// @ts-ignore
import { URLPattern } from "urlpattern-polyfill";
import { generateETag } from "../server/generateEtag";
import { v4 } from "uuid";
import type { ComponentTree } from "../client/types";
import { type RouterMiddleware } from "../http/Router";
import type { UnwrapPromise } from "../utils/type";
import { RequestBreakerError } from "../http/Error";
import type { Plugin } from "./Plugin";
import type { Middleware } from "../http/Middleware";
import { requestContext } from "../http/requestContext";
import type { ServerWebSocket } from "bun";
import { flattenComponentTree } from "../client/helpers/flattenComponentTree";

import { createComponentTree } from "./createComponentTree";
import { createFlatViewRoutes } from "./createFlatViewRoutes";
import { createRouteManifest } from "./createRouteManifest";

// @ts-ignore
import { renderToReadableStream } from "react-dom/server.browser";
import { ComponentType, createElement, Fragment } from "react";

interface RenderParams {
  styles: string[];
  views: Record<string, string>;
  manifest: Record<string, any>;
  serverManifest: Record<string, any>;
}

interface AppParams {
  viewRouter: new () => ViewRouter;
  apiRouter: new () => ApiRouter;
  plugins?: (new () => Plugin)[];
  middlewareAliases?: Record<string, new () => Middleware>;
  root: ComponentType;
}

export class App {
  private flatViewRoutes: Record<
    string,
    { exec: ViewRouteExec[]; middleware: any[] }
  > = {};
  private flatApiRoutes: Record<string, any> = {};
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

  constructor(params: AppParams) {
    this.params = params;
    this.apiRouter = params.apiRouter;
    this.viewRouter = params.viewRouter;
    this.Root = params.root;

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
    this.flatApiRoutes = this.flattenApiRoutes(apiRouters);
  }

  public printName() {
    console.log(this.name);
  }

  public getComponentTree() {
    return this.componentTree;
  }

  private flattenApiRoutes(routes: ApiRouteChildren) {
    const flatApiRoutes: Record<
      string,
      Record<string, { exec: ApiRouteExec; middleware: any[] }>
    > = {};
    for (const [rootPath, apiConfigOrApiRouter] of Object.entries(routes)) {
      if ("exec" in apiConfigOrApiRouter) {
        if (!flatApiRoutes[rootPath]) {
          flatApiRoutes[rootPath] = {};
        }
        flatApiRoutes[rootPath][apiConfigOrApiRouter.method] = {
          exec: apiConfigOrApiRouter.exec,
          middleware: [],
        };
      } else if (Array.isArray(apiConfigOrApiRouter)) {
        for (const apiConfig of apiConfigOrApiRouter) {
          if (!flatApiRoutes[rootPath]) {
            flatApiRoutes[rootPath] = {};
          }
          flatApiRoutes[rootPath][apiConfig.method] = {
            exec: apiConfig.exec,
            middleware: [],
          };
        }
      } else {
        const router = new apiConfigOrApiRouter(this);
        const middlewares = router.middlewares
          .map((alias) => {
            if (this.middlewareAliases?.[alias]) {
              const middleware = new this.middlewareAliases[alias]();
              return middleware.run;
            }
          })
          .filter(Boolean);

        const result = this.flattenApiRoutes(router.routes);
        for (const [path, handlers] of Object.entries(result)) {
          const subPath = path === "/" ? "" : path;
          const _rootPath = rootPath === "/" ? "" : rootPath;
          const finalPath =
            `${_rootPath}${subPath}` === "" ? "/" : `${_rootPath}${subPath}`;
          if (!flatApiRoutes[finalPath]) {
            flatApiRoutes[finalPath] = {};
          }
          for (const [method, handler] of Object.entries(handlers)) {
            flatApiRoutes[finalPath][method] = {
              exec: handler.exec,
              middleware: [
                router.middleware,
                ...middlewares,
                ...handler.middleware,
              ],
            };
          }
        }
      }
    }

    return flatApiRoutes;
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

    const reqWithMiddlewares = middlewares
      .map((middleware) => {
        if (typeof middleware === "string") {
          return new this.middlewareAliases[middleware]().run;
        }
        return middleware;
      })
      .reduce(
        (acc, middleware) => {
          return async (req: Request, ctx: any) => {
            return {
              ...(await acc(req, ctx)),
              ...(await middleware(req, ctx)),
            };
          };
        },
        (_req: Request, _ctx: any) => Promise.resolve({}),
      );

    const reqCtx = new Map();

    const data = await requestContext.run(reqCtx, async () => {
      await reqWithMiddlewares(req, reqCtx);
      return await Promise.all(handlers.map((fn) => fn(req, params, this)));
    });

    return {
      data,
      currentPathName,
      params,
      user: reqCtx.get("user") ?? null,
    };
  }

  async handleRequest(req: Request) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api")) {
      const apiPath = url.pathname.replace("/api", "");
      for (const [path, handler] of Object.entries(this.flatApiRoutes)) {
        const pattern = new URLPattern({ pathname: path });
        if (pattern.test({ pathname: apiPath })) {
          const params = pattern.exec({ pathname: apiPath })?.pathname.groups!;
          const exec = handler[req.method.toLowerCase()].exec;
          const middlewares = handler[req.method.toLowerCase()].middleware;
          const reqWithMiddlewares = middlewares.reduce(
            (acc: any, middleware: any) => {
              return async (req: Request, ctx: any) => {
                return {
                  ...(await acc(req, ctx)),
                  ...(await middleware(req, ctx)),
                };
              };
            },
            (req: Request) => Promise.resolve({}),
          );

          const reqCtx = new Map();

          return await requestContext.run(reqCtx, async () => {
            try {
              await reqWithMiddlewares(req, reqCtx);
            } catch (err) {
              if (err instanceof RequestBreakerError) {
                return {
                  kind: "apiError",
                  ...err.payload.api,
                };
              }
              throw err;
            }

            if (exec) {
              let data = {};
              try {
                data = await exec(req, params, this);
              } catch (err) {
                if (err instanceof RequestBreakerError) {
                  return {
                    kind: "apiError",
                    ...err.payload.api,
                  };
                }

                throw err;
              }

              return {
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
            }
          });
        }
      }
      return {
        kind: "api_404",
      };
    } else {
      let pageData: UnwrapPromise<
        ReturnType<typeof this.resolvePageData>
      > | null = null;

      try {
        pageData = await this.resolvePageData(req);
      } catch (err) {
        if (err instanceof RequestBreakerError) {
          return {
            kind: "viewError",
            ...err.payload.view,
          };
        }
      }

      // TODO: handle 404
      if (!pageData) {
        return {
          kind: "",
          data: {},
          meta: [],
          headers: {},
        };
      }

      const { data, params, currentPathName, user } = pageData;

      const viewData = data.reduce((acc, data) => {
        return {
          ...acc,
          ...data,
        };
      }, {});

      if (url.searchParams.get("json")) {
        return {
          kind: "viewData",
          data: {
            [url.pathname]: viewData,
          },
          meta: [],
          headers: {},
        };
      }

      let cookieHeaders = {};
      const visitorIdExist = req.headers.get("cookie")?.includes("visitor_id");
      if (!visitorIdExist) {
        cookieHeaders = {
          "Set-Cookie": `visitor_id=${v4()}; HttpOnly; SameSite=Strict; Path=/`,
        };
      }

      return {
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
            is404: false,
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
        status: 200,
      };
    }
  }

  async fetch(req: Request, renderParams: RenderParams) {
    const result = await this.handleRequest(req);

    if (result.kind === "viewError") {
      const { kind, ...payload } = result;
      return new Response(null, {
        ...payload,
      });
    }

    if (result.kind === "apiError") {
      const { kind, data, ...payload } = result;
      return new Response(JSON.stringify(data), {
        ...payload,
      });
    }

    if (!result) {
      return new Response("Not found", { status: 404 });
    }

    if (result.kind === "viewData") {
      const { data, headers, head } = result as any;
      return new Response(
        JSON.stringify({
          data,
          head,
        }),
        {
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (result.kind === "view") {
      const { data, headers, head, status } = result as any;
      const { styles, views, manifest, serverManifest, ...renderOptions } =
        renderParams;
      const viewImportMap = {};
      let appDir: string | null = null;
      const template = (viewName: string, path: string) =>
        `"${viewName}": () => import("${path}")`;
      const templates = [];

      for (const fileName of [
        "404",
        ...flattenComponentTree(this.componentTree),
      ]) {
        if (!manifest) {
          appDir = `${process.env.APP_DIR}`;
          const mod = await import(`${appDir}/views/${fileName}.tsx`);
          viewImportMap[fileName] = mod.default;
          templates.push(template(fileName, `${appDir}/views/${fileName}.tsx`));
        } else {
          const { file } = serverManifest[`app/views/${fileName}.tsx`];
          const mod = await import(`${process.env.DIST_DIR}/server/${file}`);
          viewImportMap[fileName] = mod.default;
          const clientFile = manifest[`app/views/${fileName}.tsx`];
          if (clientFile) {
            templates.push(template(fileName, `/${clientFile.file}`));
          }
        }
      }

      const loaders = `{${templates.join(",")}}`;

      const stream = await renderToReadableStream(
        createElement(Fragment, {
          children: [
            styles,
            createElement(this.Root as any, {
              data,
              viewImportMap,
            }),
          ],
        }),
        {
          bootstrapScriptContent: `window.__GEMI_DATA__ = ${JSON.stringify(data)}; window.loaders=${loaders}`,
          ...renderOptions,
        },
      );

      return new Response(stream, {
        status,
        headers: {
          "Content-Type": "text/html",
          ...headers,
        },
      });
    }

    if (result.kind === "api") {
      const { data, headers } = result;
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      });
    }

    return new Response("Not found", { status: 404 });
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
