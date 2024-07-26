import { AsyncLocalStorage } from "async_hooks";

const requestContext = new AsyncLocalStorage<Store>();

interface CreateCookieOptions {
  name: string;
  value: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax";
  path?: string;
  domain?: string;
  partitioned?: boolean;
}

export class Cookie {
  constructor(private options: CreateCookieOptions) {}

  toString() {
    return [
      `${this.options.name}=${this.options.value}`,
      this.options.maxAge ? `Max-Age=${this.options.maxAge}` : "",
      this.options.httpOnly ? "HttpOnly" : "",
      this.options.secure ? "Secure" : "",
      this.options.sameSite
        ? `SameSite=${this.options.sameSite}`
        : "SameSite=Strict",
      this.options.path ? `Path=${this.options.path}` : "Path=/",
      this.options.domain ? `Domain=${this.options.domain}` : "",
      this.options.expires
        ? `Expires=${this.options.expires.toUTCString()}`
        : "",
      this.options.partitioned ? "Partitioned" : "",
    ]
      .filter((i) => i !== "")
      .join("; ");
  }
}

class Store {
  cookies: Set<Cookie> = new Set();
  user: any = null;

  constructor() {
    //autobind(this as any);
  }

  setCookie(options: CreateCookieOptions) {
    this.cookies.add(new Cookie(options));
  }

  setUser(user: any) {
    this.user = user;
  }
}

export class RequestContext {
  static getStore() {
    return requestContext.getStore()!;
  }
  static run<T>(fn: () => T): T {
    return requestContext.run(new Store(), fn);
  }
}
