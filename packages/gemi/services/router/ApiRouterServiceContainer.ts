import { AuthApiRouter } from "../../auth/AuthenticationServiceProvider";
import { ApiRouter, HttpRequest } from "../../http";
import { GEMI_REQUEST_BREAKER_ERROR } from "../../http/Error";
import { I18nRouter } from "../../i18n/I18nRouter";
import { RequestContext } from "../../http/requestContext";
import { ImageOptimizationRouter } from "../image-optimization/ImageOptimizationServiceContainer";
import { LoggingRouter } from "../logging/LoggingRouter";
import { MiddlewareServiceContainer } from "../middleware/MiddlewareServiceContainer";
import { ServiceContainer } from "../ServiceContainer";
import type { ApiRouterServiceProvider } from "./ApiRouterServiceProvider";
import { createFlatApiRoutes, type FlatApiRoutes } from "./createFlatApiRoutes";
import { ViewRouterServiceContainer } from "./ViewRouterServiceContainer";
import { I18nServiceContainer } from "../../i18n/I18nServiceContainer";

class DebugRouter extends ApiRouter {
  routes = {
    "/api-routes": this.get(() => {
      const flatroutes = ApiRouterServiceContainer.use().flatRoutes;
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
      const flatroutes = ViewRouterServiceContainer.use().flatViewRoutes;
      const out = [];
      for (const [path, { middleware, viewPath }] of Object.entries(flatroutes)) {
        out.push({ path, method: "GET", viewPath, middleware });
      }
      return out;
    }),
  };
}

export class ApiRouterServiceContainer extends ServiceContainer {
  static _name = "ApiRouterServiceContainer";

  flatRoutes: FlatApiRoutes = {};

  constructor(public service: ApiRouterServiceProvider) {
    super();
    this.flatRoutes = createFlatApiRoutes({
      "/": this.service.rootRouter.bind(this.service),
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
      await MiddlewareServiceContainer.use().runMiddleware(middlewares);
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
        this.service.onRequestFail(httpRequest, err);
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
      this.service.onRequestFail(ctx.req, err);
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
      this.service.onRequestStart(httpRequest);
    }
    return await RequestContext.run(httpRequest, async () => {
      const ctx = RequestContext.getStore();

      const i18nServiceContainer = I18nServiceContainer.use();
      if (i18nServiceContainer.isEnabled) {
        const locale = i18nServiceContainer.detectLocale(httpRequest);
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
          this.service.onRequestEnd(httpRequest);
        }
        ctx.destroy();
        return response;
      }

      headers.set("Content-Type", "application/json");

      cookies.forEach((cookie) => headers.append("Set-Cookie", cookie.toString()));

      if (!req.url.includes("/__gemi__")) {
        this.service.onRequestEnd(httpRequest);
      }

      ctx.destroy();

      return new Response(JSON.stringify(data), {
        headers,
      });
    });
  }
}
