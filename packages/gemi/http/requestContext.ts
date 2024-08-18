import { AsyncLocalStorage } from "async_hooks";
import { Cookie, type CreateCookieOptions } from "./Cookie";
import { HttpRequest } from "./HttpRequest";

const requestContext = new AsyncLocalStorage<Store>();

class Store {
  cookies: Set<Cookie> = new Set();
  headers: Headers = new Headers();
  user: any = null;
  req: HttpRequest | null = null;

  constructor() {
    //autobind(this as any);
  }

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

  static async run<T>(fn: () => T): Promise<T> {
    return requestContext.run(new Store(), fn);
  }
}
