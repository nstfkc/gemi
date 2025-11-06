import {
  RequestContext,
  type CreateCookieOptions,
} from "../http/requestContext";

export const Cookie = {
  set(name: string, value: string, options: CreateCookieOptions) {
    RequestContext.getStore().setCookie(name, value, options);
  },
  setIfAbsent(name: string, value: string, options: CreateCookieOptions) {
    if (RequestContext.getStore().req.cookies.has(name)) {
      return false;
    }
    RequestContext.getStore().setCookie(name, value, options);
    return true;
  },
  delete(name: string) {
    RequestContext.getStore().deleteCookie(name);
  },
};
