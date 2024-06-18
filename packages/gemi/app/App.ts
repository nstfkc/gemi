import type {
  ApiRouteChildren,
  ApiRouteExec,
  ApiRouter,
} from "../http/ApiRouter";
import {
  ViewRouter,
  type ViewChildren,
  type ViewRouteExec,
} from "../http/ViewRouter";
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
import { flattenViewRoutes } from "./flattenViewRoutes";
import { flattenComponentTree } from "../client/helpers/flattenComponentTree";

// @ts-ignore
import { renderToReadableStream } from "react-dom/server.browser";
import { lazy, createElement, Fragment } from "react";

interface RenderParams {
  styles: string[];
  views: Record<string, string>;
  manifest: Record<string, any>;
  serverManifest: Record<string, any>;
}

const defaultHead = {
  title: "The UI Agents",
  meta: [
    { charSet: "utf-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1" },
    {
      name: "description",
      content:
        "Fastest way to start your B2B SaaS journey. Immediately access to high quality templates and slingshot your startup into the future.",
    },
  ],
  link: [{ rel: "icon", href: "/favicon.ico" }],
};

function prepareViewData(
  result: Array<{
    data: Record<string, any>;
    headers: Record<string, any>;
    head: Record<string, Record<string, any>[]>;
  }>,
) {
  return result.reduce(
    (acc, next) => {
      return {
        pageData: {
          ...acc.pageData,
          ...next.data,
        },
        headers: {
          ...acc.headers,
          ...next.headers,
        },
        head: {
          ...acc.head,
          title: next?.head?.title ?? acc.head?.title ?? "Gemi App",
          meta: [...acc.head.meta, ...(next?.head?.meta ?? [])],
          link: [...acc.head.link, ...(next?.head?.link ?? [])],
        },
      };
    },
    { pageData: {}, headers: {}, head: defaultHead },
  ) as {
    pageData: Record<string, any>;
    headers: Record<string, any>;
    head: Record<string, Record<string, any>[]>;
  };
}

interface AppParams {
  viewRouter: new (app: App) => ViewRouter;
  apiRouter: new (app: App) => ApiRouter;
  plugins?: (new () => Plugin)[];
  middlewareAliases?: Record<string, new () => Middleware>;
  RootLayout: () => JSX.Element;
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
  private apiRouter: new (app: App) => ApiRouter;
  private viewRouter: new (app: App) => ViewRouter;
  private RootLayout: () => JSX.Element;

  constructor(params: AppParams) {
    console.log("[App] initialized");
    this.params = params;
    this.apiRouter = params.apiRouter;
    this.viewRouter = params.viewRouter;
    this.RootLayout = params.RootLayout;

    this.prepare();
    console.log("[App] routes are prepared");
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
    // Handle view routes
    const { flatRoutes, routeManifest, componentTree } = flattenViewRoutes(
      viewRouters,
      this,
    );
    this.componentTree = componentTree;
    this.routeManifest = routeManifest;
    this.flatViewRoutes = flatRoutes;
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

  private flattenViewRoutes(routes: ViewChildren) {
    const flatRoutes: Record<
      string,
      { exec: ViewRouteExec[]; middleware: any[] }
    > = {};
    const routeManifest: Record<string, string[]> = {};
    const componentTree: ComponentTree = [];

    for (const [rootPath, viewConfigOrViewRouter] of Object.entries(routes)) {
      let children;
      let rootHandler: ViewRouteExec = async () => ({});
      let rootMiddleware: any[] = [];
      let layoutViewPath: string | null = null;
      if ("prepare" in viewConfigOrViewRouter) {
        const result = viewConfigOrViewRouter.prepare();
        children = result.children;
        rootHandler = result.exec;
        flatRoutes[rootPath] = {
          exec: [rootHandler],
          middleware: result.middlewares,
        };
        if (Object.keys(children).length > 0) {
          layoutViewPath = result.viewPath;
        } else {
          routeManifest[rootPath] = [result.viewPath];
          componentTree.push([result.viewPath]);
        }
      } else {
        const router = new viewConfigOrViewRouter(this);
        const middlewares = router.middlewares
          .map((alias) => {
            if (this.middlewareAliases?.[alias]) {
              const middleware = new this.middlewareAliases[alias]();
              return middleware.run;
            }
          })
          .filter(Boolean);

        rootMiddleware.push(router.middleware, ...middlewares);
        children = router.routes;
      }

      const result = this.flattenViewRoutes(children);

      if (layoutViewPath) {
        componentTree.push({ [layoutViewPath]: result.componentTree });
      } else {
        componentTree.push(...result.componentTree);
      }

      for (const [path, handlers] of Object.entries(result.flatRoutes)) {
        const subPath = path === "/" ? "" : path;
        const _rootPath = rootPath === "/" ? "" : rootPath;
        const finalPath =
          `${_rootPath}${subPath}` === "" ? "/" : `${_rootPath}${subPath}`;
        flatRoutes[finalPath] = {
          exec: [rootHandler, ...handlers.exec],
          middleware: [...rootMiddleware, ...handlers.middleware],
        };
        if (layoutViewPath) {
          routeManifest[finalPath] = [
            layoutViewPath,
            ...(result.routeManifest[path] ?? []),
          ];
        } else {
          routeManifest[finalPath] = [...(result.routeManifest[path] ?? [])];
        }
      }
    }

    return {
      flatRoutes,
      routeManifest,
      componentTree,
    };
  }

  private async resolvePageData(req: Request) {
    const url = new URL(req.url);
    let handlers: ViewRouteExec[] = [];
    let middlewares: RouterMiddleware[] = [];
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

    const reqWithMiddlewares = middlewares.reduce(
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

    const result = await requestContext.run(reqCtx, async () => {
      await reqWithMiddlewares(req, reqCtx);
      return await Promise.all(handlers.map((fn) => fn(req, params, this)));
    });

    let is404 = false;
    for (const res of result) {
      const [data] = Object.values(res.data ?? {});
      if ((data as any)?.status === 404) {
        is404 = true;
        break;
      }
    }

    return {
      is404,
      result,
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
            }

            if (exec) {
              let result = {};
              try {
                result = await exec(req, params, this);
              } catch (err) {
                if (err instanceof RequestBreakerError) {
                  return {
                    kind: "apiError",
                    ...err.payload.api,
                  };
                }
              }
              const { data, cookies = {}, headers, status } = result as any;

              return {
                kind: "api",
                data: data,
                headers: {
                  ...headers,
                  "Set-Cookie": Object.entries(cookies)
                    .map(([name, config]) => {
                      return `${name}=${(config as any).value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${(config as any).maxAge}`;
                    })
                    .join(", "),
                },
                status,
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

      const { result, params, currentPathName, is404, user } = pageData;

      const data = prepareViewData(result);

      if (url.searchParams.get("json")) {
        return {
          kind: "viewData",
          data: {
            [url.pathname]: data.pageData,
          },
          meta: [],
          headers: data.headers,
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
            [url.pathname]: data.pageData,
          },
          auth: { user },
          routeManifest: this.routeManifest,
          router: {
            pathname: currentPathName,
            params,
            currentPath: url.pathname,
            is404,
          },
          componentTree: [["404"], ...this.componentTree],
        },
        head: data.head,
        headers: {
          ...data.headers,
          "Content-Type": "text/html",
          "Cache-Control": user
            ? "private, no-cache, no-store, max-age=0, must-revalidate"
            : "public, max-age=864000, must-revalidate",
          ETag: this.appId,
          ...cookieHeaders,
        },
        status: is404 ? 404 : 200,
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
      for (const fileName of flattenComponentTree(this.componentTree)) {
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
            createElement(this.RootLayout, {
              data,
              head,
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
      const { data, headers, status } = result;
      return new Response(JSON.stringify(data), {
        status,
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
