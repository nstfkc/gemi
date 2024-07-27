import { AsyncLocalStorage } from "async_hooks";
import { Cookie, type CreateCookieOptions } from "./Cookie";
import { HttpRequest } from "./HttpRequest";

const requestContext = new AsyncLocalStorage<Store>();

class Store {
  cookies: Set<Cookie> = new Set();
  user: any = null;
  req: HttpRequest | null = null;

  constructor() {
    //autobind(this as any);
  }

  setCookie(name: string, value: string, options: CreateCookieOptions = {}) {
    this.cookies.add(new Cookie(name, value, options));
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

  static run<T>(fn: () => T): T {
    return requestContext.run(new Store(), fn);
  }
}
