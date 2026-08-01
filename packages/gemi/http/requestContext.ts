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
    delete this.user;
  }
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
}
