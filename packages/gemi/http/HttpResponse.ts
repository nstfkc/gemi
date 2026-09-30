/**
 * Marks an `HttpResponse` at runtime. A registered symbol rather than
 * `instanceof`, so a route built against one copy of gemi is still recognised by
 * a dispatcher from another (a linked package, a duplicated install) — the
 * reason `RequestBreakerError` is recognised by its `kind` too.
 */
const HTTP_RESPONSE = Symbol.for("gemi.HttpResponse");

export type HttpResponseOptions = {
  /** The status code. `200` when omitted. */
  status?: number;
  /**
   * Set on top of everything the request already put on the response. Each
   * header named here replaces the one the context holds; a `Set-Cookie` is
   * added to the cookies set during the request rather than replacing them.
   */
  headers?: HeadersInit;
};

/**
 * What the response's body is and how it is written. One member per factory;
 * `.text()` or `.redirect()` would each add one, and a `case` in `serialize`.
 */
type HttpResponseKind = "json";

/**
 * A handler's answer with a status or headers of its own, where returning the
 * data would answer `200`.
 *
 * ```ts
 * "/posts": this.post(async (req) => {
 *   const post = await Post.create({ data: (await req.input()).toJSON() });
 *   return HttpResponse.json(post, { status: 201 });
 * }),
 * ```
 *
 * Unlike a `Response` built by hand it stays typed: the route's client type is
 * `T`, exactly as if the handler had returned `data`. And it is answered through
 * the same path as a plain return, so the request's cookies, the headers set
 * with `req.ctx().setHeaders()` and whatever middleware added (CORS,
 * `Cache-Control`) are on it too.
 *
 * For api routes. A view's handler returns its props; returning one there
 * throws.
 */
export class HttpResponse<T = unknown> {
  readonly [HTTP_RESPONSE] = true;

  private constructor(
    readonly kind: HttpResponseKind,
    readonly body: T,
    readonly status: number,
    readonly headers: Headers,
  ) {}

  /**
   * `data` as JSON, with `options.status` (default `200`) and
   * `options.headers` on top of the request's own.
   *
   * A status of 400 or more answers `Cache-Control: no-store` unless
   * `options.headers` sets one, as gemi's own error responses do: a route
   * behind `cache` would otherwise let a shared cache replay one client's 404
   * to everyone.
   */
  static json<T>(data: T, options: HttpResponseOptions = {}): HttpResponse<T> {
    const status = options.status ?? 200;
    assertStatus(status);
    return new HttpResponse("json", data, status, new Headers(options.headers));
  }

  /** Whether the status is 2xx, as `Response.ok`. */
  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  /**
   * The `Response` this answers, given what the request context accumulated.
   *
   * `contextHeaders` is the request context's own `Headers` and is written
   * into, as the plain-return path always did; the dispatcher is done with it
   * once the response is built.
   *
   * @internal Called by the api dispatcher.
   */
  toResponse(contextHeaders: Headers, cookies: Iterable<string>): Response {
    const headers = contextHeaders;
    const body = this.serialize(headers);

    for (const cookie of cookies) {
      headers.append("Set-Cookie", cookie);
    }

    // Built with forEach rather than spread: the browser tsconfig's lib set
    // has DOM but not DOM.Iterable, so `Headers` has no [Symbol.iterator].
    this.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") {
        headers.set(key, value);
      }
    });
    for (const cookie of this.headers.getSetCookie()) {
      headers.append("Set-Cookie", cookie);
    }

    if (this.status >= 400 && !this.headers.has("Cache-Control")) {
      headers.set("Cache-Control", "no-store");
    }

    return new Response(body, { status: this.status, headers });
  }

  private serialize(headers: Headers): BodyInit | null {
    switch (this.kind) {
      case "json":
        headers.set("Content-Type", "application/json");
        return JSON.stringify(this.body) ?? null;
    }
  }
}

/**
 * Checked when the response is made rather than when it is sent, so the stack
 * points at the handler. `new Response` would throw for a status outside
 * 200–599 anyway, and a 204, 205 or 304 cannot carry the body `.json()` has.
 */
function assertStatus(status: number) {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(`HttpResponse: status must be an integer from 200 to 599, got ${status}.`);
  }
  if (status === 204 || status === 205 || status === 304) {
    throw new RangeError(`HttpResponse.json: a ${status} response has no body.`);
  }
}

export function isHttpResponse(value: unknown): value is HttpResponse<unknown> {
  return typeof value === "object" && value !== null && (value as any)[HTTP_RESPONSE] === true;
}

type UnwrapHttpResponse<T> = T extends HttpResponse<infer Data> ? Data : T;

/**
 * What a handler returning `Output` answers the client with: `Output` itself,
 * with every `HttpResponse<T>` in it — under a `Promise` or not, alone or in a
 * union with plain returns — replaced by its `T`. `any` stays `any`.
 */
export type ResponseData<Output> = 0 extends 1 & Output
  ? Output
  : Output extends Promise<infer Resolved>
    ? Promise<UnwrapHttpResponse<Resolved>>
    : UnwrapHttpResponse<Output>;
