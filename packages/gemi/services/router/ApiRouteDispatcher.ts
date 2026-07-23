import { AuthApiRouter } from "../../auth/routes";
import { ApiRouter, HttpRequest } from "../../http";
import { GEMI_REQUEST_BREAKER_ERROR } from "../../http/Error";
import { I18nRouter } from "../../i18n/I18nRouter";
import { RequestContext } from "../../http/requestContext";
import { ImageOptimizationRouter } from "../image-optimization/ImageManager";
import { LoggingRouter } from "../logging/LoggingRouter";
import { MiddlewareRegistry } from "../middleware/MiddlewareRegistry";
import { apiRouteConfigDefaults, type ApiRouteConfig } from "./config";
import { createFlatApiRoutes, type FlatApiRoutes } from "./createFlatApiRoutes";
import { ViewRouteDispatcher } from "./ViewRouteDispatcher";
import { Translator } from "../../i18n/Translator";
import { app } from "../../foundation/app";

class DebugRouter extends ApiRouter {
  routes = {
    "/api-routes": this.get(() => {
      const flatroutes = app(ApiRouteDispatcher).flatRoutes;
      const out = [];
      for (const [path, methods] of Object.entries(flatroutes)) {
        for (const [method, handler] of Object.entries(methods)) {
          const { exec, middleware } = handler;
          out.push({ path, method, middleware });
        }
      }
      return out;
    }),
    "/view-routes": this.get(() => {
      const flatroutes = app(ViewRouteDispatcher).flatViewRoutes;
      const out = [];
      for (const [path, { middleware, viewPath }] of Object.entries(flatroutes)) {
        out.push({ path, method: "GET", viewPath, middleware });
      }
      return out;
    }),
  };
}

export class ApiRouteDispatcher {
  static token = "router.api";

  flatRoutes: FlatApiRoutes = {};

  private readonly onRequestStart: NonNullable<ApiRouteConfig["onRequestStart"]>;
  private readonly onRequestEnd: NonNullable<ApiRouteConfig["onRequestEnd"]>;
  private readonly onRequestFail: NonNullable<ApiRouteConfig["onRequestFail"]>;

  constructor(config: ApiRouteConfig) {
    const defaults = apiRouteConfigDefaults();

    this.onRequestStart = config.onRequestStart ?? defaults.onRequestStart;
    this.onRequestEnd = config.onRequestEnd ?? defaults.onRequestEnd;
    this.onRequestFail = config.onRequestFail ?? defaults.onRequestFail;

    this.flatRoutes = createFlatApiRoutes({
      "/": config.rootRouter,
      "/auth": AuthApiRouter,
      "/__gemi__/services/i18n": I18nRouter,
      "/__gemi__/services/logs": LoggingRouter,
      "/__gemi__/services/image": ImageOptimizationRouter,
      "/__gemi__/debug": DebugRouter,
    });
  }

  public getRouteHandlerAndParams(req: Request) {
    const url = new URL(req.url);

    const apiPath = url.pathname.replace("/api", "");

    let params: Record<string, any> = {};
    let path: string;
    for (const [_path] of Object.entries(this.flatRoutes)) {
      try {
        const pattern = new URLPattern({ pathname: _path });
        if (pattern.test({ pathname: apiPath })) {
          path = _path;
          params = pattern.exec({ pathname: apiPath })?.pathname.groups!;
          break;
        }
      } catch (err) {
        console.error(err);
        // Do something
      }
    }
    return { params, path };
  }

  async runRouteMiddleware(path: string, httpRequest: HttpRequest) {
    const routeHandler = this.flatRoutes[path];
    const middlewares = routeHandler[httpRequest.rawRequest.method].middleware;
    try {
      await app(MiddlewareRegistry).runMiddleware(middlewares);
    } catch (err) {
      if (err.kind === GEMI_REQUEST_BREAKER_ERROR) {
        if (httpRequest.rawRequest.url.includes("/api")) {
          const { status = 400, data, headers } = err.payload.api;
          return new Response(JSON.stringify(data), {
            status,
            headers: {
              "Content-Type": "application/json",
              ...headers,
            },
          });
        }
      } else {
        this.onRequestFail(httpRequest, err);
        console.error(err);
        throw err;
      }
    }
  }

  async getRouteData(path: string): Promise<any> {
    const routeHandler = this.flatRoutes[path];

    const ctx = RequestContext.getStore();
    const exec = routeHandler[ctx.req.rawRequest.method].exec ?? (() => Promise.resolve({}));

    let data = {};
    try {
      data = await exec();
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
      }
      this.onRequestFail(ctx.req, err);
      console.error(err);
      throw err;
    }

    return data;
  }

  async handleApiRequest(req: Request) {
    const { params, path } = this.getRouteHandlerAndParams(req);

    const routeHandler = this.flatRoutes[path];

    if (!routeHandler || !routeHandler[req.method]) {
      return new Response(JSON.stringify({ error: { message: "Not found" } }), {
        status: 404,
      });
    }

    const httpRequest = new HttpRequest(req, params, "api", path);
    if (!req.url.includes("/__gemi__")) {
      this.onRequestStart(httpRequest);
    }
    return await RequestContext.run(httpRequest, async () => {
      const ctx = RequestContext.getStore();

      const translator = app(Translator);
      if (translator.isEnabled) {
        const locale = translator.detectLocale(httpRequest);
        ctx.setLocale(locale);
      }

      ctx.setRequest(httpRequest);
      const middlewareResponse = await this.runRouteMiddleware(path, httpRequest);

      if (middlewareResponse instanceof Response) {
        return middlewareResponse;
      }
      const data = await this.getRouteData(path);

      if (data instanceof Response) {
        return data;
      }

      const headers = ctx.headers;

      headers.append("Content-Type", "application/json");

      ctx.cookies.forEach((cookie) => headers.append("Set-Cookie", cookie.toString()));

      ctx.destroy();

      if (!req.url.includes("/__gemi__")) {
        this.onRequestEnd(httpRequest);
      }
      return new Response(JSON.stringify(data), {
        headers,
      });
    });
  }
}
