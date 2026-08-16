import { AsyncLocalStorage } from "node:async_hooks";
import type { HttpRequest } from "./HttpRequest";
import { Metadata } from "./Metadata";
import type { ByteRange } from "./range";
// Type-only: `services/router` imports from `http`, so a runtime import here
// would be circular.
import type { ServerQueryStore } from "../services/router/ServerQueryStore";

export interface CreateCookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax";
  path?: string;
  domain?: string;
  partitioned?: boolean;
}

export function createCookie(
  name: string,
  value: string,
  options: CreateCookieOptions = {},
) {
  return [
    `${name}=${value}`,
    options.maxAge ? `Max-Age=${options.maxAge}` : "",
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
    options.sameSite ? `SameSite=${options.sameSite}` : "SameSite=Strict",
    options.path ? `Path=${options.path}` : "Path=/",
    options.domain ? `Domain=${options.domain}` : "",
    options.expires ? `Expires=${options.expires.toUTCString()}` : "",
    options.partitioned ? "Partitioned" : "",
  ]
    .filter((i) => i !== "")
    .join("; ");
}

const requestContext = new AsyncLocalStorage<Store>();

class Store {
  cookies: Set<string> = new Set();
  headers: Headers = new Headers();
  /**
   * Every server-side query of this request — prefetched or discovered during
   * the streaming render. Assigned by the view router (or lazily by the
   * `Query` facade); `null` for api requests, which must not query themselves.
   */
  serverQueries: ServerQueryStore | null = null;
  user: any = null;
  csrfHmac: string | null = null;
  locale: string | null = null;
  metadata = new Metadata();
  /**
   * The parsed `Range` of the in-flight request, picked up by
   * `FileStorage.read()` so a range reaches the storage backend without every
   * handler having to thread it through by hand.
   *
   * Only populated inside a `this.stream()` route, and cleared once that route
   * returns: a `FileStorage.read()` in an ordinary handler must never start
   * silently returning partial bytes.
   */
  rangeRequest: ByteRange | null = null;

  /**
   * This request's `session_id`, once read or minted.
   *
   * The cookie itself cannot answer for it. `setCookie` appends a *serialized*
   * `Set-Cookie` string to `cookies`, so a value written during this request is
   * not readable back out of it, and `req.cookies` still holds only what the
   * browser sent. Anything needing the id in the same request that mints it —
   * feature-flag bucketing, most obviously — has to read it from here.
   */
  sessionId: string | null = null;

  /**
   * This request's feature-flag evaluations, computed once.
   *
   * One map per request is what keeps a handler and the SSR payload from
   * disagreeing: a percentage rollout evaluated twice would be consistent
   * anyway — the bucketing is deterministic — but an attribute hook reading a
   * clock, or a `now`-based rule, would not be. Anything the page renders and
   * anything the server branched on have to be the same answer.
   */
  featureEvaluations: Map<string, unknown> | null = null;
  /** The context those evaluations were made against, built at most once. */
  featureContext: unknown = null;
  /** Bucket memo, shared across every flag evaluated for this request. */
  featureBuckets: Map<string, number> | null = null;

  constructor(public req: HttpRequest) {}

  setLocale(locale: string) {
    this.locale = locale;
  }

  renderMeta() {
    return this.metadata.render();
  }

  setCSRFHmac(hmac: string) {
    this.csrfHmac = hmac;
  }

  setCookie(name: string, value: string, options: CreateCookieOptions = {}) {
    this.cookies.add(createCookie(name, value, options));
  }

  deleteCookie(name: string) {
    this.cookies.add(createCookie(name, "", { maxAge: -1 }));
  }

  setHeaders(name: string, value: string) {
    this.headers.set(name, value);
  }

  setUser(user: any) {
    this.user = user;
  }

  setRequest(req: HttpRequest<any, any>) {
    this.req = req;
  }

  destroy() {
    delete this.cookies;
    delete this.headers;
    this.serverQueries = null;
    this.sessionId = null;
    this.featureEvaluations = null;
    this.featureContext = null;
    this.featureBuckets = null;
    delete this.user;
  }
}

export const SESSION_ID_COOKIE = "session_id";

/**
 * The `session_id` the browser sent, or the one minted earlier in this request.
 * Never mints one, so it is safe on an api request, where a `Set-Cookie` nobody
 * asked for would be a surprise.
 *
 * `null` outside a request, and for an anonymous visitor whose first request is
 * not a view — both meaning "no stable subject", which callers must handle
 * rather than paper over with a random value. A per-call random id would give
 * every request its own bucket, which is worse than no bucketing at all: a
 * percentage rollout would reshuffle on every page load.
 */
export function sessionId(): string | null {
  const store = RequestContext.getStore();
  if (!store) {
    return null;
  }
  if (store.sessionId) {
    return store.sessionId;
  }
  const sent = store.req?.cookies?.get(SESSION_ID_COOKIE);
  if (sent) {
    store.sessionId = sent;
  }
  return store.sessionId;
}

/**
 * The same, but mints and sets the cookie when the browser sent none.
 *
 * Call this once per **view** request, early enough that everything downstream —
 * flag evaluation included — sees the same id the browser is about to be given.
 * It used to live inline in `ViewRouteDispatcher.onRequestEnd`, which ran only
 * on the document path and only after the response was decided, so a client-side
 * navigation minted nothing and a first-ever visitor had no id at the point
 * flags were evaluated.
 */
export function ensureSessionId(): string | null {
  const store = RequestContext.getStore();
  if (!store) {
    return null;
  }
  const existing = sessionId();
  if (existing) {
    return existing;
  }

  const minted = Bun.randomUUIDv7();
  store.sessionId = minted;
  store.setCookie(SESSION_ID_COOKIE, minted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // `Lax`, not `Strict`, and the difference is load-bearing. `Strict`
    // withholds the cookie on cross-site *top-level navigation*, so a visitor
    // arriving from a search result or a shared link would arrive without it,
    // be minted a new id, and overwrite the old one — re-bucketing on every
    // external entry, which is how most anonymous traffic arrives. This is not
    // a credential (`access_token` stays `Strict`); it is an opaque bucketing
    // id, and `Lax` still blocks cross-site POST.
    sameSite: "Lax",
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
  });
  return minted;
}

export class RequestContext {
  static getStore() {
    return requestContext.getStore()!;
  }

  static setRequest(req: HttpRequest<any, any>) {
    requestContext.getStore().req = req;
  }

  static run<T>(httpRequest: HttpRequest, fn: () => T): T {
    return requestContext.run(new Store(httpRequest), fn);
  }

  /**
   * Re-enters an *existing* request scope. Stream lifecycle callbacks fire
   * after the HTTP server has taken over the response body — outside the
   * AsyncLocalStorage scope the request ran in — so the view router captures
   * the live store and re-enters it around user-facing hooks, keeping
   * `req.ctx()` (and everything context-backed) working inside them.
   */
  static runWith<T>(store: Store, fn: () => T): T {
    return requestContext.run(store, fn);
  }
}
