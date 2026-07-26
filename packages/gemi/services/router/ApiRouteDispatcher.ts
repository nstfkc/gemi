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

  /**
   * Copies request-context headers and cookies onto a Response a handler built
   * itself, without disturbing what the handler already set.
   */
  private mergeContextIntoResponse(
    response: Response,
    headers: Headers,
    cookies: Set<string>,
  ) {
    // Built with forEach rather than spread: the browser tsconfig's lib set
    // has DOM but not DOM.Iterable, so `Headers` has no [Symbol.iterator].
    const entries: [string, string][] = [];
    headers?.forEach((value, key) => entries.push([key, value]));
    const setCookies = [
      ...(typeof headers?.getSetCookie === "function"
        ? headers.getSetCookie()
        : []),
      ...Array.from(cookies ?? []),
    ];

    if (entries.length === 0 && setCookies.length === 0) {
      return response;
    }

    const apply = (target: Headers) => {
      for (const [key, value] of entries) {
        if (key.toLowerCase() === "set-cookie") {
          continue;
        }
        if (!target.has(key)) {
          target.set(key, value);
        }
      }
      for (const cookie of setCookies) {
        target.append("Set-Cookie", cookie);
      }
    };

    try {
      // Mutating in place keeps the original Response object, and with it a
      // sized Blob body — rebuilding turns that into a stream, which costs the
      // Content-Length that Bun only emits for known-length bodies.
      apply(response.headers);
      return response;
    } catch {
      // A Response from fetch() — this.proxy() routes — has immutable headers.
      const merged = new Headers(response.headers);
      apply(merged);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
      });
    }
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

      const headers = ctx.headers;
      const cookies = ctx.cookies;

      if (data instanceof Response) {
        // A handler owning its own Response — stream, file and proxy routes,
        // and the RequestBreakerError path in getRouteData — still has to carry
        // what the request context accumulated: headers set by middleware via
        // ctx.setHeaders (CORS, Cache-Control) and any Set-Cookie. The
        // response's own headers win; the context only fills gaps.
        const response = this.mergeContextIntoResponse(data, headers, cookies);

        if (!req.url.includes("/__gemi__")) {
          // Before destroy(), which empties the store the hook reads from.
          this.onRequestEnd(httpRequest);
        }
        ctx.destroy();
        return response;
      }

      headers.set("Content-Type", "application/json");

      cookies.forEach((cookie) => headers.append("Set-Cookie", cookie.toString()));

      if (!req.url.includes("/__gemi__")) {
        this.onRequestEnd(httpRequest);
      }

      ctx.destroy();

      return new Response(JSON.stringify(data), {
        headers,
      });
    });
  }
}
