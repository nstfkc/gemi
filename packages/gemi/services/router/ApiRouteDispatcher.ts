import { AuthApiRouter } from "../../auth/routes";
import { ACCESS_TOKEN } from "../../auth/accessToken";
import type { User } from "../../auth/types";
import type { McpGrant, ProgressSink } from "../../http/modelOriginated";
import { ApiRouter, HttpRequest } from "../../http";
import { GEMI_REQUEST_BREAKER_ERROR, refusal } from "../../http/Error";
import { HttpResponse, isHttpResponse } from "../../http/HttpResponse";
import { I18nRouter } from "../../i18n/I18nRouter";
import { type CarriedContext, RequestContext } from "../../http/requestContext";
import { ImageOptimizationRouter } from "../image-optimization/ImageManager";
import { LoggingRouter } from "../logging/LoggingRouter";
import { MiddlewareRegistry } from "../middleware/MiddlewareRegistry";
import { apiRouteConfigDefaults, type ApiRouteConfig } from "./config";
import { createFlatApiRoutes, type FlatApiRoutes } from "./createFlatApiRoutes";
import { ViewRouteDispatcher } from "./ViewRouteDispatcher";
import { Translator } from "../../i18n/Translator";
import { app } from "../../foundation/app";
import { markModelOriginated } from "../../http/modelOriginated";
import { setRequestDomain } from "../../http/requestDomain";
import { clientIp } from "../../http/RateLimitMiddleware";
import { ormContext } from "../../orm/context";
import { Log } from "../../facades/Log";
import { isPolicyDeniedError, isRecordNotFoundError } from "../../orm/errors";
import { apiPath } from "./apiPath";
import { notFoundResponse } from "./notFound";
import { policyDeniedResponse } from "./policyDenied";

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
 * Credentials of the app's own that a `dispatchAs` request carries beside
 * gemi's access token: a cookie an app middleware reads (an anonymous owner's
 * id), or a header the app signed for this call (a short-lived grant).
 *
 * A `null` or `undefined` value is skipped, so `req.cookies.get("x")` can be
 * passed as it is. The values are sent as given — a cookie value is not
 * encoded, the same as `HttpRequest.cookies` reads it.
 */
export type DispatchCredentials = {
  headers?: Record<string, string | null | undefined>;
  cookies?: Record<string, string | null | undefined>;
};

export type DispatchAsOptions = {
  credentials?: DispatchCredentials;
  /**
   * Dispatches as this user instead of copying the initiator's access token
   * (#762): the user is on the request context before the route's middleware
   * runs, as a global middleware's would be, so `auth` passes and policies
   * see them. For a caller whose identity was verified some other way than a
   * gemi session — a remote MCP client's OAuth token or API key — which has
   * no session token to copy, and whose own credential must not be passed on.
   *
   * Only trusted code builds one: it is exactly as powerful as an app
   * middleware calling `setUser`, and gemi's only writer is the MCP registry,
   * from a principal a caller resolver verified. With it, nothing of the
   * initiator's credentials is copied — not its `access_token` cookie or
   * header — so a request that carried both cannot run as the session's user.
   * `grant` is what `req.mcpGrant()` answers on the dispatched request.
   */
  identity?: DispatchIdentity;
  /** Aborts the dispatched request: its `req.signal`, for a route that honours it. */
  signal?: AbortSignal;
  /**
   * Receives what the route reports with `req.reportProgress` — a remote MCP
   * client's `notifications/progress`.
   */
  progress?: ProgressSink;
};

export type DispatchIdentity = {
  user: User;
  grant?: McpGrant;
};

/**
 * Headers `credentials` may not set. Each one is either gemi's identity, which
 * stays the initiator's, or something `dispatchAs` writes itself: the body's
 * framing, the cookie jar it builds, the host the request is routed by, and
 * the agent a session is bound to. `x-forwarded-*` and `forwarded` are refused
 * as a prefix and a name: they are how a proxy describes a client, and the
 * synthetic request has no proxy in front of it.
 */
const RESERVED_HEADERS = new Set([
  ACCESS_TOKEN,
  "cookie",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
  "user-agent",
  "forwarded",
]);

/** RFC 6265's cookie-name: an HTTP token. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** RFC 6265's cookie-octets: no control characters, whitespace, `"`, `,`, `;` or a backslash. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

function applyCredentials(headers: Headers, cookies: string[], credentials: DispatchCredentials) {
  for (const [name, value] of Object.entries(credentials.headers ?? {})) {
    if (value === undefined || value === null) continue;
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) {
      throw new Error(
        `dispatchAs: credentials may not set the "${name}" header. The access token stays the initiator's, and the request's framing is dispatchAs's own.`,
      );
    }
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(credentials.cookies ?? {})) {
    if (value === undefined || value === null) continue;
    if (name === ACCESS_TOKEN) {
      throw new Error(
        `dispatchAs: credentials may not set the "${ACCESS_TOKEN}" cookie. The access token stays the initiator's.`,
      );
    }
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
      throw new Error(`dispatchAs: "${name}" is not a cookie a Cookie header can carry.`);
    }
    cookies.push(`${name}=${value}`);
  }
}

/**
 * The same response, with a body that calls `end` once when it is read to the
 * end, errors, or is cancelled — Bun cancels it when the client disconnects.
 * Once, and not once per path: a cancel lands while a read is in flight, and
 * that read then finishes too.
 *
 * Status, status text and every header are carried over, `Set-Cookie`s the
 * context merged in included. A body nobody reads or cancels never ends; the
 * server always does one or the other, and the store is collected with it.
 */
function endWhenBodyEnds(response: Response, end: () => void): Response {
  const reader = response.body!.getReader();
  let ended = false;
  const endOnce = () => {
    if (ended) {
      return;
    }
    ended = true;
    try {
      end();
    } catch (err) {
      // An `onRequestEnd` that throws here would error a body the client has
      // already read in full. Nobody is left to answer a 500 to.
      console.error(err);
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          endOnce();
          controller.error(err);
          return;
        }
        if (chunk.done) {
          // Synchronous when nothing is pending, so whoever reads to the end
          // finds `onRequestEnd` already run when they see `done`. The order
          // against close() does not decide that — the reader resumes in a
          // later microtask either way — the synchronous end does.
          endOnce();
          try {
            controller.close();
          } catch {
            // Already cancelled; the cancel path has ended it.
          }
          return;
        }
        try {
          controller.enqueue(chunk.value);
        } catch {
          // Cancelled while this read was in flight.
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          endOnce();
        }
      },
    },
    // Read the handler's stream only as fast as the client does.
    { highWaterMark: 0 },
  );

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A RequestBreakerError's `api` payload as a Response, from a middleware or a
 * handler.
 *
 * `no-store` unless the breaker says otherwise, as `policyDeniedResponse` does:
 * the context's headers fill this Response's gaps, and `cache` puts the route's
 * Cache-Control there for the success it expected. A 429, 401 or 403 that
 * inherited `public, max-age=864000` would let a shared cache answer one
 * client's rejection to everyone for ten days.
 */
export function breakResponse(payload: {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}) {
  const { status = 400, data, headers: own } = payload;
  const headers = new Headers({ "Content-Type": "application/json", ...own });
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Copies request-context headers and cookies onto a Response a handler built
 * itself, or a middleware's break or policy 403, without disturbing what that
 * Response already set. Also what puts a global middleware's context on the
 * response a request ends with (`globalMiddleware.ts`).
 */
export function mergeContextIntoResponse(
  response: Response,
  headers: Headers,
  cookies: Set<string>,
) {
  // Built with forEach rather than spread: the browser tsconfig's lib set
  // has DOM but not DOM.Iterable, so `Headers` has no [Symbol.iterator].
  const entries: [string, string][] = [];
  headers?.forEach((value, key) => entries.push([key, value]));
  const setCookies = [
    ...(typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : []),
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

    const routePath = apiPath(url.pathname);

    let params: Record<string, any> = {};
    let path: string;
    for (const [_path] of Object.entries(this.flatRoutes)) {
      try {
        const pattern = new URLPattern({ pathname: _path });
        if (pattern.test({ pathname: routePath })) {
          path = _path;
          params = pattern.exec({ pathname: routePath })?.pathname.groups!;
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
        // Unconditionally: every request here is an api request, whatever its
        // url says. A break that returned nothing would let the handler run
        // after the middleware rejected the request.
        return breakResponse(err.payload.api);
      } else {
        // Before `onRequestFail`, for the reason a `RequestBreakerError` is:
        // the record not existing is the answer to the request, not a failure
        // of it. A middleware that loads the record the route is about — the
        // membership row, the tenant — asks the same question the handler does.
        if (isRecordNotFoundError(err)) {
          return notFoundResponse();
        }
        this.onRequestFail(httpRequest, err);
        console.error(err);
        // A middleware can load a policied model, a membership check say, and
        // its denial is the same refusal as the handler's.
        if (isPolicyDeniedError(err)) {
          return policyDeniedResponse();
        }
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
        return breakResponse(err.payload.api);
      }
      // Before `onRequestFail` and the log, unlike a policy denial below. A
      // route keyed on an id from the url answers this for every stale link
      // and every crawler, so reporting it would drown the failures that are
      // the server's. It is a 404 in the access log like any other.
      if (isRecordNotFoundError(err)) {
        return notFoundResponse();
      }
      this.onRequestFail(ctx.req, err);
      console.error(err);
      // Answered here rather than in `server/`, so an in-process `dispatchAs`
      // call gets the same 403 a client does. Left to throw, it became the
      // server's 500 with the policy's message as its body.
      if (isPolicyDeniedError(err)) {
        return policyDeniedResponse();
      }
      throw err;
    }

    return data;
  }

  /**
   * The matched route, not the URL: a query value that mentions `/__gemi__`
   * would otherwise keep an app route out of onRequestStart/End.
   */
  private isFrameworkRoute(path: string) {
    return path.startsWith("/__gemi__");
  }

  /**
   * How every request that started ends: `onRequestEnd`, then `destroy()`.
   * One place, so an exit cannot answer without it — a break that skipped it
   * left request logging with a start and no end for exactly the rejected
   * requests. `ctx` is passed rather than read so a caller that ends the
   * request later, outside the request's async scope, can still reach it.
   *
   * Work handed to `ctx.waitUntil` — an agent run the client may have left —
   * holds both back until it settles. With none, the end is not deferred, as
   * it always was, so a plain JSON response has ended before it is returned.
   * The hold applies on every path, JSON included: a route that starts a run
   * and answers without waiting for it ends when the run does, so a duration
   * logged in `onRequestEnd` spans the run, not the response. That is the
   * point — the run's tools need the user — but it is not "response sent".
   *
   * The hook is awaited, since destroy() empties the store it reads from, and
   * a hook that fails is logged rather than thrown: it must not turn the
   * response it was told about into a 500, nor skip the destroy() after it.
   */
  private async endRequest(
    ctx: ReturnType<typeof RequestContext.getStore>,
    httpRequest: HttpRequest,
    path: string,
  ) {
    const end = async () => {
      try {
        if (!this.isFrameworkRoute(path)) {
          await this.onRequestEnd(httpRequest);
        }
      } catch (err) {
        Log.error(err?.message ?? 'Error in "onRequestEnd" event handler', {
          err: JSON.stringify(err),
        });
      } finally {
        // A hook that throws still releases the user, cookies and headers.
        ctx.destroy();
      }
    };
    if (!ctx.hasPendingWork()) {
      await end();
      return;
    }
    void ctx
      .whenIdle()
      .then(end)
      .catch((err) => {
        // The response is long gone; there is no one left to answer a 500 to.
        console.error(err);
      });
  }

  /**
   * Whether a handler's Response is still running code after it is returned.
   * A body with no declared length is: an SSE stream, an agent run, anything
   * built on a `ReadableStream`, all of which may read `req.ctx()` between
   * chunks. A declared `Content-Length` means the bytes were decided before
   * the handler returned — every sized file `this.stream()` serves has one —
   * and those are left alone, because wrapping a body costs it that header:
   * Bun sends any stream body chunked, and a file then loses its length and
   * the server's sendfile path. The only way to see a body end is to wrap it,
   * and Bun gives no way to tell a stream body from a string or a Blob, so a
   * handler's own `new Response("…")` is wrapped too; its end then waits for
   * the body to be read.
   *
   * A HEAD response is never open-ended, whatever its body: Bun.serve drops
   * that body without reading or cancelling it, so a wrapped one would never
   * end, and the store would keep the user until it was collected. A stream
   * route answers HEAD, and its 404, a breaker's JSON or a handler's own
   * Response can all carry an unsized body there.
   *
   * `Content-Length` is checked before `response.body`, and the order matters:
   * on Bun 1.3.14 on Linux, reading `.body` of a Response built on a sliced
   * Blob — a `this.stream()` Range response — turns it into a stream that runs
   * past the slice's end, and Bun.serve then sends the rest of the object
   * under a 206 (#725).
   */
  private isOpenEndedBody(request: Request, response: Response) {
    return (
      request.method !== "HEAD" && !response.headers.has("Content-Length") && response.body !== null
    );
  }

  async handleApiRequest(req: Request, carried?: CarriedContext | null) {
    const { params, path } = this.getRouteHandlerAndParams(req);

    const routeHandler = this.flatRoutes[path];

    if (!routeHandler || !routeHandler[req.method]) {
      return new Response(JSON.stringify({ error: refusal("not_found", "Not found", 404) }), {
        status: 404,
      });
    }

    const httpRequest = new HttpRequest(req, params, "api", path);
    if (!this.isFrameworkRoute(path)) {
      this.onRequestStart(httpRequest);
    }
    return await RequestContext.run(httpRequest, async () => {
      const ctx = RequestContext.getStore();
      // Set once this request's end has run, been scheduled, or been handed to
      // a streaming body, so the throw path below never ends it twice.
      let endDecided = false;
      const end = async () => {
        endDecided = true;
        await this.endRequest(ctx, httpRequest, path);
      };

      try {
        const translator = app(Translator);
        if (translator.isEnabled) {
          const locale = translator.detectLocale(httpRequest);
          ctx.setLocale(locale);
        }

        ctx.setRequest(httpRequest);
        // Before the route's middleware, whose own `body-limit` replaces it.
        app(MiddlewareRegistry).applyDefaultBodyLimit(req);
        const middlewareResponse = await this.runRouteMiddleware(path, httpRequest);

        if (middlewareResponse instanceof Response) {
          // A breaker's or a policy denial's Response carries what the earlier
          // middleware put on the context, as a handler's does. Returned as is,
          // a 401 or 429 after `cors` had no CORS headers, so the browser
          // reported an opaque CORS failure instead of the status, and a
          // Set-Cookie set before the break was lost. Merged before the end,
          // which destroys the context's headers and cookies.
          const response = mergeContextIntoResponse(middlewareResponse, ctx.headers, ctx.cookies);
          await end();
          return response;
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
          const response = mergeContextIntoResponse(data, headers, cookies);
          if (this.isOpenEndedBody(req, response)) {
            // Ended by its body rather than here: a streaming agent route
            // returns before any of its tools run, and ending now would destroy
            // the `user` every one of them reads.
            const streamed = endWhenBodyEnds(response, () =>
              this.endRequest(ctx, httpRequest, path),
            );
            endDecided = true;
            return streamed;
          }
          await end();
          return response;
        }

        // A plain return is `HttpResponse.json(data)`: one path writes the
        // context's headers and cookies onto both, and an `HttpResponse` only
        // adds its status and headers on top of them.
        const response = (isHttpResponse(data) ? data : HttpResponse.json(data)).toResponse(
          headers,
          cookies,
        );

        await end();

        return response;
      } catch (err) {
        // A middleware or handler that throws something other than a break or
        // a policy denial has already run onRequestFail, and its error goes on
        // to the server's 500 (or back to a dispatchAs caller). A throw from
        // before the middleware, such as detectLocale, skips onRequestFail but
        // ends here all the same. Either way the request still ends: without
        // this, an app pairing onRequestStart with onRequestEnd saw a start and
        // no end for exactly the requests that crashed, and the store kept its
        // user and cookies until collected.
        if (!endDecided) {
          try {
            await end();
          } catch (endErr) {
            // A throwing onRequestEnd must not replace the error the server
            // renders; destroy() has run regardless.
            console.error(endErr);
          }
        }
        throw err;
      }
    }, carried);
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
   * behind too: it is client-written, and copying it would pass it off as part
   * of a request the server built. The initiator's address is resolved here
   * with `clientIp` instead and carried beside the model-originated marker, so
   * a tool call spends the rate-limit budget of the user who started the run
   * rather than one `unknown:<route>` budget shared by every user's agent.
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
   *
   * `options.credentials` adds the app's own credentials to the request — a
   * cookie or a signed header its middleware reads — beside the access token,
   * never instead of it. Nothing is copied from the initiator on the app's
   * behalf: the app names each value, so an app that wants a cookie of the
   * initiator's forwarded reads it and passes it. The names that would swap
   * the identity or the framing are refused with a throw (see
   * `RESERVED_HEADERS`). The app's middleware still decides what a credential
   * is worth, so this grants nothing a direct request carrying the same
   * values would not get.
   */
  async dispatchAs(
    initiator: HttpRequest<any, any>,
    method: InProcessMethod,
    path: string,
    body?: FormData | Record<string, unknown>,
    options?: DispatchAsOptions,
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

    // gemi's own token, on both transports, is the only identity carried. A
    // user the initiator's global middleware signed in some other way — an
    // SSO header, an API key — is not: no global middleware runs for this
    // request and nothing from the initiator's context crosses over, so its
    // `auth` routes refuse such a user, failing closed — unless the app passes
    // that credential itself as `options.credentials`, which is the app's
    // decision to make, value by value.
    const identity = options?.identity;
    if (identity !== undefined && (typeof identity !== "object" || !identity?.user)) {
      throw new Error("dispatchAs: identity needs the user to dispatch as.");
    }
    const headers = new Headers();
    const cookies: string[] = [];
    const cookieToken = identity ? null : initiator.cookies.get(ACCESS_TOKEN);
    if (cookieToken) {
      cookies.push(`${ACCESS_TOKEN}=${cookieToken}`);
    }
    if (options?.credentials) {
      applyCredentials(headers, cookies, options.credentials);
    }
    if (cookies.length > 0) {
      headers.set("Cookie", cookies.join("; "));
    }
    const headerToken = identity ? null : initiator.headers.get(ACCESS_TOKEN);
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

    const req = new Request(url, {
      method,
      headers,
      body: requestBody,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    markModelOriginated(req, clientIp(initiator), identity?.grant, options?.progress);
    // The tool call acts for the same tenant as the request that started it.
    if (initiator.domain) {
      setRequestDomain(req, initiator.domain);
    }

    // Started from outside the initiator's scopes, as the server's `fetch` is.
    // `handleApiRequest` opens a fresh request store of its own, but
    // `onRequestStart` runs before it does and would otherwise see the
    // initiator's. The ORM scope is the one that matters: inside an
    // `asSystem` block, or an `asUser` for someone else, the route's queries
    // would skip or swap the policies a client's request would meet. The
    // kernel scope is kept — it is the Application, not a caller.
    // An identity rides in as a global middleware's user does: on the new
    // request's store, before its middleware runs.
    const carried = identity ? { user: identity.user } : undefined;
    return RequestContext.exit(() =>
      ormContext.exit(() => this.handleApiRequest(req, carried)),
    );
  }
}
