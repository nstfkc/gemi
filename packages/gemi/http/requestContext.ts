import { AsyncLocalStorage } from "async_hooks";
import { Cookie, type CreateCookieOptions } from "./Cookie";
import { HttpRequest } from "./HttpRequest";

const requestContext = new AsyncLocalStorage<Store>();

class Store {
  cookies: Set<Cookie> = new Set();
  headers: Headers = new Headers();
  prefetchedResources = new Map<string, Record<string, any>>();
  user: any = null;

  constructor(public req: HttpRequest) {}

  setCookie(name: string, value: string, options: CreateCookieOptions = {}) {
    this.cookies.add(new Cookie(name, value, options));
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
