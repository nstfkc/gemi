import type { Refusal } from "./refusal";

/**
 * Marks an `HttpResponse` at runtime. A registered symbol rather than
 * `instanceof`, so a route built against one copy of gemi is still recognised by
 * a dispatcher from another (a linked package, a duplicated install) — the
 * reason `RequestBreakerError` is recognised by its `kind` too.
 */
const HTTP_RESPONSE = Symbol.for("gemi.HttpResponse");

export type HttpResponseOptions<S extends number = number> = {
  /** The status code. `200` when omitted. */
  status?: S;
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
export class HttpResponse<T = unknown, S extends number = number> {
  readonly [HTTP_RESPONSE] = true;

  private constructor(
    readonly kind: HttpResponseKind,
    readonly body: T,
    readonly status: S,
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
  static json<T, S extends number = 200>(
    data: T,
    options: HttpResponseOptions<S> = {},
  ): HttpResponse<T, S> {
    const status = options.status ?? 200;
    assertStatus(status);
    return new HttpResponse("json", data, status as S, new Headers(options.headers));
  }

  /**
   * A typed error: `{ "error": body }` with a status from 400 to 599, the
   * envelope gemi's own errors answer.
   *
   * ```ts
   * if (expired(link)) {
   *   return HttpResponse.error(410, { kind: "gone", message: "Link has expired" });
   * }
   * return { catalogId };
   * ```
   *
   * The route's client type leaves it out of the data and adds `body` to the
   * error type instead: `onError` and `error` on `useMutation`, `usePost`,
   * `useUpload` and `<Form>` are `MutationError | typeof body` (with `status`
   * added), so `if (!(e instanceof Error) && e.kind === "gone")` narrows.
   * `httpError(status, body)` is the same function.
   */
  static error<const E, S extends number>(
    status: S,
    body: E,
    options: Omit<HttpResponseOptions, "status"> = {},
  ): HttpResponse<{ error: E }, S> {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(
        `HttpResponse.error: status must be an integer from 400 to 599, got ${status}.`,
      );
    }
    return HttpResponse.json({ error: body }, { ...options, status });
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

/**
 * `HttpResponse.error(status, body)`: a typed error response. See
 * `HttpResponse.error`.
 */
export function httpError<const E, S extends number>(
  status: S,
  body: E,
  options: Omit<HttpResponseOptions, "status"> = {},
): HttpResponse<{ error: E }, S> {
  return HttpResponse.error(status, body, options);
}

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/**
 * Whether `S` is known to be 400 or more: a literal status, or a union of
 * them, every one of which is. `number`, and a union with a 2xx in it, are
 * not, so a status picked at run time stays in the data as it always was.
 */
type IsErrorStatus<S> = [S] extends [never]
  ? false
  : [`${S & number}`] extends [`4${Digit}${Digit}` | `5${Digit}${Digit}`]
    ? true
    : false;

// One member of a handler's resolved output, as the client's data: an
// `HttpResponse` is its body, unless its status is an error one; anything else
// is itself.
type SuccessMember<T> =
  T extends HttpResponse<infer Data, infer S>
    ? IsErrorStatus<S> extends true
      ? never
      : Data
    : T;

/**
 * A raw `Response` in a union with typed returns is dropped: the client never
 * receives a `Response` object, and it was the success type `if (r instanceof
 * Response)` had to be written against. A route that only ever returns one (a
 * file, a stream) keeps it, as before.
 */
type SuccessData<T> = [Exclude<SuccessMember<T>, Response>] extends [never]
  ? SuccessMember<T>
  : Exclude<SuccessMember<T>, Response>;

/**
 * What a handler returning `Output` answers the client with on success:
 * `Output` itself, with every `HttpResponse<T>` in it — under a `Promise` or
 * not, alone or in a union with plain returns — replaced by its `T`.
 *
 * Left out: an `HttpResponse` whose status is a literal 400 or more
 * (`HttpResponse.error`, `httpError`, `HttpResponse.json(x, { status: 409 })`),
 * which `ResponseError` collects instead, and a raw `Response` in a union with
 * anything else. `any` stays `any`.
 */
export type ResponseData<Output> = 0 extends 1 & Output
  ? Output
  : // Not distributive: `SuccessData` has to see the whole union to know
    // whether a raw `Response` is alone in it.
    [Output] extends [Promise<infer Resolved>]
    ? Promise<SuccessData<Resolved>>
    : [Extract<Output, Promise<any>>] extends [never]
      ? SuccessData<Output>
      : // A sync handler returning a promise on one branch: member by member.
        Output extends Promise<infer Resolved>
        ? Promise<SuccessData<Resolved>>
        : SuccessData<Output>;

/**
 * The value the client's `onError` receives for an error body `E` answered
 * with status `S`, as `mutationErrorFromBody` builds it: `status` is added
 * unless `E` has one, an object with a `message` and no `kind` is given the
 * kind its status stands for, and a string (or nothing) becomes a refusal.
 */
export type ClientHttpError<E, S extends number = number> = E extends string | null | undefined
  ? Refusal
  : E extends object
    ? E extends { kind: string }
      ? WithStatus<E, S>
      : E extends { message: string }
        ? WithStatus<E, S> & { kind: Refusal["kind"] }
        : WithStatus<E, S>
    : E;

type WithStatus<E, S extends number> = "status" extends keyof E ? E : E & { status: S };

// The error body the client sees for one `HttpResponse`: the `error` field when
// there is one, as gemi's own errors carry it, otherwise the body.
type ErrorMember<T> =
  T extends HttpResponse<infer Data, infer S>
    ? IsErrorStatus<S> extends true
      ? Data extends { error: infer E }
        ? ClientHttpError<E, S>
        : ClientHttpError<Data, S>
      : never
    : never;

/**
 * The typed errors a handler returning `Output` can answer: every
 * `HttpResponse` in it whose status is a literal 400 or more, as the client's
 * `onError` receives it (see `ClientHttpError`). `never` when there are none,
 * and for `any`.
 */
export type ResponseError<Output> = 0 extends 1 & Output ? never : ErrorMember<Awaited<Output>>;
