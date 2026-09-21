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
import { markModelOriginated } from "../../http/modelOriginated";
import { ormContext } from "../../orm/context";

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

export type InProcessMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The only credential `AuthenticationMiddleware` reads, as the `access_token`
 * cookie or else an `access_token` header.
 */
const ACCESS_TOKEN = "access_token";

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
    // The matched route, not the URL: a query value that mentions `/__gemi__`
    // would otherwise keep an app route out of onRequestStart/End.
    const isFrameworkRoute = path.startsWith("/__gemi__");
    if (!isFrameworkRoute) {
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

        if (!isFrameworkRoute) {
          // Before destroy(), which empties the store the hook reads from.
          this.onRequestEnd(httpRequest);
        }
        ctx.destroy();
        return response;
      }

      headers.set("Content-Type", "application/json");

      cookies.forEach((cookie) => headers.append("Set-Cookie", cookie.toString()));

      if (!isFrameworkRoute) {
        this.onRequestEnd(httpRequest);
      }

      ctx.destroy();

      return new Response(JSON.stringify(data), {
        headers,
      });
    });
  }

  /**
   * Runs an api route in-process, as the user who made `initiator`, through
   * exactly what a client's request to `path` would go through: route match,
   * `onRequestStart`, middleware, handler, `onRequestEnd`. Answers the
   * `Response` that client would get, and throws what `handleApiRequest` throws
   * — the server's 500 rendering lives in `server/`, not here.
   *
   * It must never reach for a flat route's `exec`, however much shorter that
   * is: `exec` is the handler alone, with no auth, no policies and no rate
   * limit, and a tool call that could do more than the same user's HTTP request
   * is the one thing the MCP router promises cannot happen.
   *
   * `initiator` is an argument rather than `RequestContext.getStore().req` so a
   * caller with no ambient gemi request — a remote MCP client — only has to
   * produce one to use this. Only its origin and credentials are read. Every
   * other header describes the initiator's own body and transport:
   * `content-type` would mis-parse this body, and a copied cookie jar would
   * hand the route state nobody decided to give it. `x-forwarded-for` is left
   * behind too, which has a cost worth knowing: `RateLimitMiddleware`'s default
   * key falls back to `unknown:<route>`, one budget shared by every in-process
   * call. How a tool call should be limited is the RFC's open question 3, and a
   * copied header would only have answered it by accident.
   *
   * `path` is the route's path as the app routes it, without `/api`, with its
   * params filled in and any query string attached — `/42/orders?status=open`.
   * A param from a model must be `encodeURIComponent`ed by the caller: a path
   * that URL parsing would rewrite — a `..` segment walking out of the route —
   * is refused rather than resolved, as is anything under `/__gemi__`, which
   * skips the lifecycle hooks and is not an app route. So is `/auth`: its
   * routes are the framework's, and a tool call that signed out the session
   * that started the run, or signed in to a cookie nobody keeps, is never what
   * a model meant.
   */
  async dispatchAs(
    initiator: HttpRequest<any, any>,
    method: InProcessMethod,
    path: string,
    body?: FormData | Record<string, unknown>,
  ): Promise<Response> {
    const origin = new URL(initiator.rawRequest.url).origin;
    const url = new URL(`${origin}/api${path}`);
    const expectedPathname = `/api${path.split(/[?#]/)[0]}`;
    if (
      !path.startsWith("/") ||
      url.origin !== origin ||
      url.pathname !== expectedPathname ||
      url.hash !== "" ||
      url.pathname.startsWith("/api/__gemi__") ||
      url.pathname === "/api/auth" ||
      url.pathname.startsWith("/api/auth/")
    ) {
      throw new Error(
        `dispatchAs: "${path}" is not an app api path. Pass the route's own path, without "/api", with every param encoded.`,
      );
    }

    const headers = new Headers();
    const cookieToken = initiator.cookies.get(ACCESS_TOKEN);
    if (cookieToken) {
      headers.set("Cookie", `${ACCESS_TOKEN}=${cookieToken}`);
    }
    const headerToken = initiator.headers.get(ACCESS_TOKEN);
    if (headerToken) {
      headers.set(ACCESS_TOKEN, headerToken);
    }
    // Not a credential, but `AuthManager.getSession` gets it beside the token,
    // so a user provider that binds a session to its agent sees the same one it
    // would for the user.
    const userAgent = initiator.headers.get("User-Agent");
    if (userAgent) {
      headers.set("User-Agent", userAgent);
    }

    let requestBody: BodyInit | undefined;
    if (body instanceof FormData) {
      // No content-type of our own: the runtime writes the multipart boundary.
      requestBody = body;
    } else if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }

    const req = new Request(url, { method, headers, body: requestBody });
    markModelOriginated(req);

    // Started from outside the initiator's scopes, as the server's `fetch` is.
    // `handleApiRequest` opens a fresh request store of its own, but
    // `onRequestStart` runs before it does and would otherwise see the
    // initiator's. The ORM scope is the one that matters: inside an
    // `asSystem` block, or an `asUser` for someone else, the route's queries
    // would skip or swap the policies a client's request would meet. The
    // kernel scope is kept — it is the Application, not a caller.
    return RequestContext.exit(() =>
      ormContext.exit(() => this.handleApiRequest(req)),
    );
  }
}
